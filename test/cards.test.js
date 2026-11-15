import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { agentPanes, createCardBuilder, panesOfActiveSpace } from '../src/cards.js';
import { cardModel } from '../src/card-model.js';
import { formatDuration } from '../src/format.js';
import { parseCompactionConfig, sessionDirSlug } from '../src/providers/omp-sources.js';
import { parseSessionFiles } from '../src/providers/session-files.js';
import { NA, readStats, registerProvider } from '../src/providers/index.js';

const FIXTURE = readFileSync(new URL('./fixtures/omp/basic.jsonl', import.meta.url), 'utf8');
const HOME = '/Users/me';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const ORIGIN = 'git@github.com:jeffujioka/herdr-session-stats.git';

// A pane as herdr's panes() reports it, plus `machine` (the machine of its space; null here).
function pane(overrides = {}) {
  return { pane: 'p1', terminal: 't1', tab: 'tb1', title: 'omp', cwd: `${HOME}/work/app`, branch: 'main', status: 'idle', app: 'omp', focused: false, machine: null, ...overrides };
}

// Stand-in with the exact signature of herdr's `exec(command, args, options)`, answering the
// read-only programs the mod runs. `world` describes machines (`null` is this computer):
//   { home, os, sessions: { dir: [{ mtimeMs, size, name }] }, text, db, config (config.yml text), git: { cwd: { branch, origin } } }
// Anything it does not know exits 1 (so a figure reads n/a); a machine in `unreachable` rejects
// and one in `hang` never answers.
function fakeExec(world, { unreachable = [], hang = [] } = {}) {
  const calls = [];
  async function exec(command, args = [], options = {}) {
    calls.push({ command, args, options });
    const machine = options.on ?? null;
    if (unreachable.includes(machine)) throw new Error(`machine ${machine} is unreachable`);
    if (hang.includes(machine)) return new Promise(() => {});
    const w = world[machine] ?? {};
    const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
    const fail = { code: 1, stdout: '', stderr: '' };
    if (command === 'uname') return ok(`${w.os ?? 'Darwin'}\n`);
    if (command === 'printenv') return w.home ? ok(`${w.home}\n`) : fail;
    if (command === 'find') {
      const files = w.sessions?.[args[0]];
      if (!files) return { code: 1, stdout: '', stderr: 'No such file or directory' };
      return ok(files.map((f) => `${Math.floor(f.mtimeMs / 1000)} ${f.size} ${args[0]}/${f.name}`).join('\n') + '\n');
    }
    if (command === 'tail') return w.text === undefined ? fail : ok(w.text);
    // first line of a session file: the title entry; `w.titles` maps a file name to its title
    if (command === 'head') {
      const title = w.titles?.[args.at(-1).split('/').pop()];
      return title === undefined ? fail : ok(`${JSON.stringify({ type: 'title', v: 1, title })}\n`);
    }
    if (command === 'sqlite3') return w.db === undefined ? fail : ok(JSON.stringify(w.db));
    if (command === 'git') {
      const repo = w.git?.[options.cwd];
      if (!repo) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      if (args[0] === 'branch') return ok(`${repo.branch ?? ''}\n`);
      return repo.origin == null ? { code: 2, stdout: '', stderr: '' } : ok(`${repo.origin}\n`);
    }
    throw new Error(`unexpected program ${command}`);
  }
  // `readTextFile(path, { on })`: the machine's config.yml text, or null when it has none
  const reads = [];
  async function readTextFile(path, options) {
    const machine = options?.on ?? null;
    reads.push({ path, on: machine });
    if (hang.includes(machine)) return new Promise(() => {});
    if (unreachable.includes(machine)) throw new Error(`machine ${machine} is unreachable`);
    return path.endsWith('/.omp/agent/config.yml') ? (world[machine]?.config ?? null) : null;
  }
  return { exec, readTextFile, calls, reads };
}

const SESSION_DIR = `${HOME}/.omp/agent/sessions/-work-app`;
const SESSION = { name: '2026-11-15T11-58-00-000Z_aaaa.jsonl', mtimeMs: NOW - 60_000, size: FIXTURE.length };

function localWorld(extra = {}) {
  return {
    null: { sessions: { [SESSION_DIR]: [SESSION] }, text: FIXTURE, git: { [`${HOME}/work/app`]: { branch: 'main', origin: ORIGIN } }, ...extra },
  };
}

function builder(world, options) {
  const { exec, readTextFile, calls, reads } = fakeExec(world, options);
  return { build: createCardBuilder({ exec, readTextFile, home: HOME }).build, calls, reads };
}

describe('cards', () => {
  test('agent pane has a card', async () => {
    const { build } = builder(localWorld());
    const cards = await build([pane()], NOW);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 'p1', folder: `${HOME}/work/app`, branch: 'main', origin: ORIGIN, harness: 'omp' });
    expect(cards[0].stats.model).toBe(readStats('omp', FIXTURE, NOW).model);
    expect(cards[0].stats.model).not.toBe(NA);
  });

  test('no agent no card', async () => {
    const { build, calls } = builder(localWorld());
    // a terminal that still reports `app` after its agent exited has no status
    const panes = [
      pane({ pane: 'p1', app: null, status: null }),
      pane({ pane: 'p2', terminal: null, app: null, mod: 'files' }),
      pane({ pane: 'p3', terminal: 't3', app: 'omp', status: null }),
    ];
    expect(agentPanes(panes)).toEqual([]);
    expect(await build(panes, NOW)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('cards keep the pane order', async () => {
    const { build } = builder(localWorld());
    const cards = await build([pane({ pane: 'a', cwd: '/x' }), pane({ pane: 'shell', app: null }), pane({ pane: 'b', cwd: '/y' })], NOW);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test("a card carries its pane's status, focus and machine", async () => {
    const { build } = builder(localWorld());
    const [working, focused] = await build([pane({ pane: 'a', status: 'working' }), pane({ pane: 'b', terminal: 't2', cwd: '/y', status: 'blocked', focused: true })], NOW);
    expect(working).toMatchObject({ status: 'working', focused: false, machine: null });
    expect(focused).toMatchObject({ status: 'blocked', focused: true });

    // also the card of a pane on a machine that cannot be reached
    const down = builder(localWorld(), { unreachable: ['bs'] });
    const [remote] = await down.build([pane({ machine: 'bs', status: 'done', focused: true })], NOW);
    expect(remote).toMatchObject({ status: 'done', focused: true, machine: 'bs' });
  });

  test("only the active space's panes get cards", async () => {
    // herdr's spaces(): each with its tabs and `active`; a pane names its tab
    const tab = (id) => ({ id });
    const spaces = [
      { id: 'sp1', active: false, machine: null, tabs: [tab('tb-other')] },
      { id: 'sp2', active: true, machine: null, tabs: [tab('tb1'), tab('tb2')] },
      { id: 'sp3', active: false, machine: 'box', tabs: [tab('tb-remote')] },
    ];
    const panes = [
      pane({ pane: 'other', tab: 'tb-other' }),
      pane({ pane: 'a', tab: 'tb1' }),
      pane({ pane: 'b', tab: 'tb2', cwd: '/y' }),
      pane({ pane: 'remote', tab: 'tb-remote', machine: 'box' }),
    ];

    expect(panesOfActiveSpace(panes, spaces).map((p) => p.pane)).toEqual(['a', 'b']);
    expect(panesOfActiveSpace(panes, [])).toEqual([]);

    const { build } = builder(localWorld());
    const cards = await build(panesOfActiveSpace(panes, spaces), NOW);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('panes without a linked session each keep a card with n/a figures', async () => {
    const { build } = builder(localWorld({ sessions: {} }));
    const cards = await build([pane({ pane: 'p1' }), pane({ pane: 'p2', terminal: 't2' })], NOW);
    expect(cards.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(cards[0]).toMatchObject({ folder: `${HOME}/work/app`, branch: 'main', origin: ORIGIN, harness: 'omp' });
    expect(cards[0].stats).toEqual({ ...readStats('', null, NOW), harness: 'omp' });
  });

  test('the newest session file wins', async () => {
    const old = { name: 'old.jsonl', mtimeMs: NOW - 4 * 60_000, size: 10 };
    const { build, calls } = builder(localWorld({ sessions: { [SESSION_DIR]: [old, SESSION] } }));
    await build([pane()], NOW);
    expect(calls.find((c) => c.command === 'tail').args.at(-1)).toBe(`${SESSION_DIR}/${SESSION.name}`);
  });

  test('panes in one folder show their own sessions, told apart by the pane title', async () => {
    const older = { name: 'older.jsonl', mtimeMs: NOW - 30 * 60_000, size: 10 };
    const world = localWorld({
      sessions: { [SESSION_DIR]: [older, SESSION] },
      titles: { [older.name]: 'FACT: Enable factory config', [SESSION.name]: '' },
    });
    const { build, calls } = builder(world);
    const panes = [
      pane({ pane: 'new', terminal: 't1', title: 'π > app' }),
      pane({ pane: 'old', terminal: 't2', title: 'π > FACT: Enable factory config' }),
    ];

    const cards = await build(panes, NOW);

    // both sessions are shown, in pane order, and the folder was listed once for both panes
    expect(cards.map((c) => c.id)).toEqual(['new', 'old']);
    expect(calls.filter((c) => c.command === 'find')).toHaveLength(1);
    expect(calls.filter((c) => c.command === 'tail').map((c) => c.args.at(-1)).sort()).toEqual(
      [`${SESSION_DIR}/${older.name}`, `${SESSION_DIR}/${SESSION.name}`].sort(),
    );
  });

  test('a folder with one agent pane reads no title', async () => {
    const { build, calls } = builder(localWorld({ titles: { [SESSION.name]: 'x' } }));
    await build([pane()], NOW);
    expect(calls.filter((c) => c.command === 'head')).toEqual([]);
  });

  test('a session file whose time is unchanged has its title read once', async () => {
    const older = { name: 'older.jsonl', mtimeMs: NOW - 30 * 60_000, size: 10 };
    const world = localWorld({ sessions: { [SESSION_DIR]: [older, SESSION] }, titles: { [older.name]: 'FACT', [SESSION.name]: '' } });
    const { build, calls } = builder(world);
    const panes = [pane({ pane: 'a', terminal: 't1' }), pane({ pane: 'b', terminal: 't2' })];
    const heads = () => calls.filter((c) => c.command === 'head').length;

    await build(panes, NOW);
    expect(heads()).toBe(2);
    await build(panes, NOW + 2000);
    expect(heads()).toBe(2);

    // a file written since is read again, the other one is not
    older.mtimeMs += 60_000;
    await build(panes, NOW + 4000);
    expect(heads()).toBe(3);
  });

  test('an unsupported harness shows its name and n/a figures', async () => {
    const { build } = builder(localWorld());
    const [card] = await build([pane({ app: 'claude-code' })], NOW);
    expect(card).toMatchObject({ harness: 'claude-code', harnessName: 'Claude Code' });
    expect(card.stats).toEqual({ ...readStats('', null, NOW), harness: 'claude-code' });
  });

  test('a new provider needs no card change', async () => {
    // a harness the cards know nothing of: one registry entry with its own hook, and the pane
    // of its app gets a card, drawn like any other
    const seen = [];
    let listed = 0;
    registerProvider('acme-agent', {
      readStats: (input) => ({ model: input.model, totalTokens: input.tokens }),
      createSessions: () => ({
        async link(where) {
          seen.push(where);
          return { path: `${where.cwd}/acme.log`, mtimeMs: NOW - 1000, size: 5 };
        },
        async read(file, where) {
          seen.push({ file, where });
          return { model: 'acme-1', tokens: 1234 };
        },
        async list() {
          listed += 1;
          throw new Error('list failed');
        },
      }),
    });
    const { build, calls } = builder(localWorld());
    const [card] = await build([pane({ app: 'acme-agent' })], NOW);

    expect(card).toMatchObject({ id: 'p1', folder: `${HOME}/work/app`, harness: 'acme-agent', harnessName: 'acme-agent' });
    expect(card.stats).toMatchObject({ harness: 'acme-agent', model: 'acme-1', totalTokens: 1234, costUsd: NA });
    // the hook was asked about the pane's folder on the pane's machine, and read the file it linked
    expect(seen[0]).toMatchObject({ machine: null, cwd: `${HOME}/work/app`, home: HOME, os: 'Darwin' });
    // no built-in hook reads the time, so the card does not hand it in
    expect(seen[0]).not.toHaveProperty('now');
    expect(seen[1].file.path).toBe(`${HOME}/work/app/acme.log`);
    // the card has the figures the provider gave; the rest read n/a
    const m = cardModel(card, { home: HOME });
    expect(m.groups[0].model.value).toBe('acme-1');
    expect(m.groups[2].figures.find((f) => f.label === 'Tokens').value).toBe('1k');
    expect(m.groups[2].hero.value).toBe(NA);
    // no omp or Claude Code program was run for it
    expect(calls.map((c) => c.command).filter((command) => command === 'find' || command === 'tail' || command === 'sqlite3')).toEqual([]);

    // two panes of the folder, whose `list` fails: the group falls back to the single link, so
    // the panes still show the linked session (collapsed to one card) rather than n/a
    const both = await build([pane({ app: 'acme-agent' }), pane({ app: 'acme-agent', pane: 'p2', terminal: 't2' })], NOW);
    expect(listed).toBe(1);
    expect(both).toHaveLength(1);
    expect(both[0].stats).toMatchObject({ model: 'acme-1', totalTokens: 1234 });
  });

  test('the branch of the pane wins; git fills a missing one and the origin', async () => {
    const world = localWorld();
    world.null.git[`${HOME}/work/app`] = { branch: 'from-git', origin: null };
    const { build } = builder(world);
    expect((await build([pane({ branch: 'live' })], NOW))[0]).toMatchObject({ branch: 'live', origin: null });
    expect((await build([pane({ branch: null })], NOW))[0]).toMatchObject({ branch: 'from-git', origin: null });
  });

  test('a folder without git has no branch or origin', async () => {
    const { build } = builder(localWorld({ git: {} }));
    const [card] = await build([pane({ branch: null })], NOW);
    expect(card).toMatchObject({ branch: null, origin: null });
  });

  test('git facts are cached between refreshes', async () => {
    const { build, calls } = builder(localWorld());
    await build([pane()], NOW);
    await build([pane()], NOW + 2000);
    expect(calls.filter((c) => c.command === 'git')).toHaveLength(2);
  });

  test('every program runs with a timeout', async () => {
    const { build, calls } = builder(localWorld());
    await build([pane()], NOW);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options.timeout).toBeGreaterThan(0);
  });

  test('omp figures use the model catalogue and compaction settings', async () => {
    const world = localWorld({
      db: [{ id: 'claude-sonnet-5.5-1m', contextWindow: 1000000 }],
      config: 'compaction:\n  enabled: true\n  thresholdTokens: -1\n  thresholdPercent: -1\n  modelThresholds: {}\n',
    });
    const { build, calls, reads } = builder(world);
    const [card] = await build([pane()], NOW);
    expect(card.stats.contextMax).toBe(1000000);
    expect(card.stats.headroomTokens).not.toBe(NA);
    const sqlite = calls.find((c) => c.command === 'sqlite3');
    expect(sqlite.args.slice(0, 3)).toEqual(['-readonly', '-json', `${HOME}/.omp/agent/models.db`]);
    expect(sqlite.args[3]).toContain("'github-copilot:'");
    // the settings come from config.yml; omp's own CLI writes its database when it starts
    expect(reads).toEqual([{ path: `${HOME}/.omp/agent/config.yml`, on: null }]);
    expect(calls.some((c) => c.command === 'omp')).toBe(false);
  });

  test('a missing sqlite3, database or config.yml reads n/a', async () => {
    const db = [{ id: 'claude-sonnet-5.5-1m', contextWindow: 1000000 }];
    const config = 'compaction:\n  enabled: true\n';
    // [what is there, contextMax, whether the headroom is known]
    const cases = [
      ['database and config.yml', { db, config }, 1000000, true],
      ['no database', { config }, NA, false],
      ['no config.yml', { db }, 1000000, false],
      ['a config.yml the reader does not understand', { db, config: 'compaction:\n  thresholdTokens: 1e5\n' }, 1000000, false],
      ['neither', {}, NA, false],
    ];
    for (const [name, extra, contextMax, known] of cases) {
      const { build } = builder(localWorld(extra));
      const [card] = await build([pane()], NOW);
      expect([name, card.stats.contextMax]).toEqual([name, contextMax]);
      expect([name, card.stats.headroomTokens !== NA]).toEqual([name, known]);
      expect(card.stats.model).not.toBe(NA);
    }
  });

  test('catalogue and compaction settings are read once a minute', async () => {
    const world = localWorld({ db: [{ id: 'claude-sonnet-5.5-1m', contextWindow: 1000000 }], config: 'compaction:\n  enabled: true\n' });
    const { build, calls, reads } = builder(world);
    await build([pane()], NOW);
    await build([pane()], NOW + 2000);
    expect(calls.filter((c) => c.command === 'sqlite3')).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await build([pane()], NOW + 61_000);
    expect(calls.filter((c) => c.command === 'sqlite3')).toHaveLength(2);
    expect(reads).toHaveLength(2);
  });

  test('a machine that never answers does not hold back the local cards', async () => {
    const { exec, readTextFile, calls } = fakeExec(localWorld(), { hang: ['bs'] });
    const { build } = createCardBuilder({ exec, readTextFile, home: HOME });
    const panes = [pane({ pane: 'remote', machine: 'bs' }), pane({ pane: 'local', terminal: 't2' })];
    const onBs = () => calls.filter((c) => c.options.on === 'bs').length;
    let latest = [];
    let done = false;
    build(panes, NOW, (cards) => (latest = cards)).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(latest.map((c) => c.id)).toEqual(['local']);
    expect(latest[0].stats.model).not.toBe(NA);
    expect(done).toBe(false);

    // the next refresh does not start the stuck pane again, and the local card keeps coming
    const asked = onBs();
    expect(asked).toBeGreaterThan(0);
    build(panes, NOW + 2000, (cards) => (latest = cards));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onBs()).toBe(asked);
    expect(latest.map((c) => c.id)).toEqual(['local']);
  });

  test('a pane still being resolved is loading, not an empty list of agents', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { exec, readTextFile } = fakeExec(localWorld());
    const slow = async (...args) => {
      await gate;
      return exec(...args);
    };
    const { build } = createCardBuilder({ exec: slow, readTextFile, home: HOME });
    const panes = [pane()];
    const updates = [];
    const first = build(panes, NOW, (cards) => updates.push(cards.map((c) => c.id)));

    // a later tick starts nothing and returns at once, with no card yet: that empty list is
    // not "no agents" (the mod counts agentPanes for that) and not a settled result
    const second = await build(panes, NOW + 2000, (cards) => updates.push(cards.map((c) => c.id)));
    expect(second).toEqual([]);
    expect(agentPanes(panes)).toHaveLength(1);
    expect(updates.every((ids) => ids.length === 0)).toBe(true);

    // the card arrives through the call that started the pane
    release();
    expect(await first).toHaveLength(1);
    expect(updates.at(-1)).toEqual(['p1']);
  });

  test('an unreachable machine still gives a card with the folder', async () => {
    const { build } = builder({}, { unreachable: ['bs'] });
    const [card] = await build([pane({ machine: 'bs', branch: null })], NOW);
    expect(card).toMatchObject({ id: 'p1', folder: `${HOME}/work/app`, branch: null, origin: null });
    expect(card.stats.model).toBe(NA);
  });

  test('one failing pane does not take the others down', async () => {
    const world = localWorld();
    const { exec, readTextFile } = fakeExec(world);
    const flaky = async (command, args, options) => {
      if (options?.cwd === '/boom' || args?.[0]?.includes('-boom')) throw new Error('boom');
      return exec(command, args, options);
    };
    const { build } = createCardBuilder({ exec: flaky, readTextFile, home: HOME });
    const cards = await build([pane({ pane: 'bad', cwd: '/boom' }), pane({ pane: 'good' })], NOW);
    expect(cards.map((c) => c.id)).toEqual(['bad', 'good']);
    expect(cards[0].stats.model).toBe(NA);
    expect(cards[1].stats.model).not.toBe(NA);
  });
});

describe('session folder', () => {
  test('folders under home drop the home prefix', () => {
    expect(sessionDirSlug('/Users/me/projects/x', '/Users/me')).toBe('-projects-x');
    expect(sessionDirSlug('/Users/me/.git_downloads/dotfiles', '/Users/me')).toBe('-.git_downloads-dotfiles');
    expect(sessionDirSlug('/Users/me', '/Users/me')).toBe('-');
    expect(sessionDirSlug('/Users/me/x/', '/Users/me')).toBe('-x');
  });

  test('folders outside home keep their path between double dashes', () => {
    expect(sessionDirSlug('/private/tmp', '/Users/me')).toBe('--private-tmp--');
    expect(sessionDirSlug('/Users/meow/x', '/Users/me')).toBe('--Users-meow-x--');
  });

  test('stat output parses to files, and bad lines are skipped', () => {
    const out = '1763204280 2048 /d/a.jsonl\nnot a line\n1763204400 10 /d/with space.jsonl\n\n';
    expect(parseSessionFiles(out)).toEqual([
      { path: '/d/a.jsonl', mtimeMs: 1763204280000, size: 2048 },
      { path: '/d/with space.jsonl', mtimeMs: 1763204400000, size: 10 },
    ]);
  });

  test('the compaction block of config.yml is read', () => {
    const yml =
      'theme:\n  dark: x\ncompaction:\n  enabled: true  # on\n  thresholdTokens: 150000\n  thresholdPercent: -1\n  modelThresholds:\n    "github-copilot/claude-*": 60\n    other/model: 70\nupdate:\n  auto: true\n';
    expect(parseCompactionConfig(yml)).toEqual({
      enabled: true,
      thresholdTokens: 150000,
      thresholdPercent: -1,
      modelThresholds: { 'github-copilot/claude-*': 60, 'other/model': 70 },
    });
  });

  test('a config without a compaction block sets nothing', () => {
    expect(parseCompactionConfig('theme:\n  dark: x\n')).toEqual({});
    expect(parseCompactionConfig('compaction: {}\n')).toEqual({});
  });

  test('YAML the reader does not understand is unknown, not a guess', () => {
    expect(parseCompactionConfig('compaction: {thresholdTokens: 1}\n')).toBeNull();
    expect(parseCompactionConfig('compaction:\n  methodOrder: [a, b]\n')).toBeNull();
    expect(parseCompactionConfig('compaction:\n  methodOrder:\n    - a\n')).toBeNull();
    expect(parseCompactionConfig('compaction:\n\tenabled: true\n')).toBeNull();
    // a scalar in a notation the reader does not know is not read as a string and ignored
    for (const value of ['1e5', '1_000', '0x10', '"x" y', 'no', 'On', 'True']) {
      expect(parseCompactionConfig(`compaction:\n  thresholdTokens: ${value}\n`)).toBeNull();
    }
    expect(parseCompactionConfig('compaction:\n  remoteEndpoint: https://x.test/v1\n')).toEqual({ remoteEndpoint: 'https://x.test/v1' });
  });
});

describe('card text', () => {
  test('durations', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(NA)).toBe(NA);
  });
});
