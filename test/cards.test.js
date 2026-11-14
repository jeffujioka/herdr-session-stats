import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { agentPanes, createCardBuilder, describeCard, formatDuration, parseSessionFiles, sessionDirSlug } from '../src/cards.js';
import { NA, readStats } from '../src/providers/index.js';

const FIXTURE = readFileSync(new URL('./fixtures/omp/basic.jsonl', import.meta.url), 'utf8');
const HOME = '/Users/me';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const ORIGIN = 'git@github.com:jeffujioka/herdr-session-stats.git';

// A pane as herdr's panes() reports it, plus `machine` (the machine of its space; null here).
function pane(overrides = {}) {
  return { pane: 'p1', terminal: 't1', tab: 'tb1', title: 'omp', cwd: `${HOME}/work/app`, branch: 'main', status: 'idle', app: 'omp', machine: null, ...overrides };
}

// Stand-in with the exact signature of herdr's `exec(command, args, options)`, answering the
// read-only programs the mod runs. `world` describes machines (`null` is this computer):
//   { home, os, sessions: { dir: [{ mtimeMs, size, name }] }, text, db, config, git: { cwd: { branch, origin } } }
// Anything it does not know exits 1 (so a figure reads n/a); a machine in `unreachable` rejects.
function fakeExec(world, { unreachable = [] } = {}) {
  const calls = [];
  async function exec(command, args = [], options = {}) {
    calls.push({ command, args, options });
    const machine = options.on ?? null;
    if (unreachable.includes(machine)) throw new Error(`machine ${machine} is unreachable`);
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
    if (command === 'sqlite3') return w.db === undefined ? fail : ok(JSON.stringify(w.db));
    if (command === 'omp') return w.config === undefined ? fail : ok(w.config);
    if (command === 'git') {
      const repo = w.git?.[options.cwd];
      if (!repo) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      if (args[0] === 'branch') return ok(`${repo.branch ?? ''}\n`);
      return repo.origin == null ? { code: 2, stdout: '', stderr: '' } : ok(`${repo.origin}\n`);
    }
    throw new Error(`unexpected program ${command}`);
  }
  return { exec, calls };
}

const SESSION_DIR = `${HOME}/.omp/agent/sessions/-work-app`;
const SESSION = { name: '2026-11-15T11-58-00-000Z_aaaa.jsonl', mtimeMs: NOW - 60_000, size: FIXTURE.length };

function localWorld(extra = {}) {
  return {
    null: { sessions: { [SESSION_DIR]: [SESSION] }, text: FIXTURE, git: { [`${HOME}/work/app`]: { branch: 'main', origin: ORIGIN } }, ...extra },
  };
}

function builder(world, options) {
  const { exec, calls } = fakeExec(world, options);
  return { build: createCardBuilder({ exec, home: HOME }).build, calls };
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
    const panes = [pane({ pane: 'p1', app: null, status: null }), pane({ pane: 'p2', terminal: null, app: null, mod: 'files' })];
    expect(agentPanes(panes)).toEqual([]);
    expect(await build(panes, NOW)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('cards keep the pane order', async () => {
    const { build } = builder(localWorld());
    const cards = await build([pane({ pane: 'a', cwd: '/x' }), pane({ pane: 'shell', app: null }), pane({ pane: 'b', cwd: '/y' })], NOW);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('two panes on one session collapse to one card', async () => {
    const { build } = builder(localWorld());
    const cards = await build([pane({ pane: 'p1' }), pane({ pane: 'p2', terminal: 't2' })], NOW);
    expect(cards.map((c) => c.id)).toEqual(['p1']);
  });

  test('panes without a linked session each keep a card with n/a figures', async () => {
    const { build } = builder(localWorld({ sessions: {} }));
    const cards = await build([pane({ pane: 'p1' }), pane({ pane: 'p2', terminal: 't2' })], NOW);
    expect(cards.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(cards[0]).toMatchObject({ folder: `${HOME}/work/app`, branch: 'main', origin: ORIGIN, harness: 'omp' });
    expect(cards[0].stats).toEqual({ ...readStats('', null, NOW), harness: 'omp' });
  });

  test('a stale session is not linked', async () => {
    const stale = { ...SESSION, mtimeMs: NOW - 20 * 60_000 };
    const { build, calls } = builder(localWorld({ sessions: { [SESSION_DIR]: [stale] } }));
    const [card] = await build([pane()], NOW);
    expect(card.stats.model).toBe(NA);
    expect(calls.some((c) => c.command === 'tail')).toBe(false);
  });

  test('the newest session file wins', async () => {
    const old = { name: 'old.jsonl', mtimeMs: NOW - 4 * 60_000, size: 10 };
    const { build, calls } = builder(localWorld({ sessions: { [SESSION_DIR]: [old, SESSION] } }));
    await build([pane()], NOW);
    expect(calls.find((c) => c.command === 'tail').args.at(-1)).toBe(`${SESSION_DIR}/${SESSION.name}`);
  });

  test('an unsupported harness shows its name and n/a figures', async () => {
    const { build } = builder(localWorld());
    const [card] = await build([pane({ app: 'claude-code' })], NOW);
    expect(card).toMatchObject({ harness: 'claude-code', harnessName: 'Claude Code' });
    expect(card.stats).toEqual({ ...readStats('', null, NOW), harness: 'claude-code' });
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
      config: '  compaction.enabled = true (boolean)\n  compaction.thresholdTokens = -1 (number)\n  compaction.thresholdPercent = -1 (number)\n  compaction.modelThresholds = {} (record)\n  compaction.reserveTokens = (not set) (number)\n',
    });
    const { build, calls } = builder(world);
    const [card] = await build([pane()], NOW);
    expect(card.stats.contextMax).toBe(1000000);
    expect(card.stats.headroomTokens).not.toBe(NA);
    const sqlite = calls.find((c) => c.command === 'sqlite3');
    expect(sqlite.args.slice(0, 3)).toEqual(['-readonly', '-json', `${HOME}/.omp/agent/models.db`]);
    expect(sqlite.args[3]).toContain("'github-copilot:'");
    expect(calls.find((c) => c.command === 'omp').args).toEqual(['config', 'list']);
  });

  test('a missing sqlite3 or omp reads n/a', async () => {
    const { build } = builder(localWorld());
    const [card] = await build([pane()], NOW);
    expect(card.stats.contextMax).toBe(NA);
    expect(card.stats.headroomTokens).toBe(NA);
    expect(card.stats.model).not.toBe(NA);
  });

  test('catalogue and compaction settings are read once a minute', async () => {
    const world = localWorld({ db: [{ id: 'claude-sonnet-5.5-1m', contextWindow: 1000000 }], config: '' });
    const { build, calls } = builder(world);
    await build([pane()], NOW);
    await build([pane()], NOW + 2000);
    expect(calls.filter((c) => c.command === 'sqlite3')).toHaveLength(1);
    expect(calls.filter((c) => c.command === 'omp')).toHaveLength(1);
    await build([pane()], NOW + 61_000);
    expect(calls.filter((c) => c.command === 'sqlite3')).toHaveLength(2);
  });

  test('a pane on another machine is read on that machine', async () => {
    const dir = '/home/dev/.omp/agent/sessions/-work-app';
    const world = {
      bs: {
        os: 'Linux',
        home: '/home/dev',
        sessions: { [dir]: [SESSION] },
        text: FIXTURE,
        git: { '/home/dev/work/app': { branch: 'remote-branch', origin: ORIGIN } },
      },
    };
    const { build, calls } = builder(world);
    const [card] = await build([pane({ cwd: '/home/dev/work/app', branch: null, machine: 'bs' })], NOW);
    expect(card).toMatchObject({ folder: '/home/dev/work/app', branch: 'remote-branch', origin: ORIGIN });
    expect(card.stats.model).not.toBe(NA);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options.on).toBe('bs');
    const find = calls.find((c) => c.command === 'find');
    expect(find.args.slice(0, 1)).toEqual([dir]);
    expect(find.args).toContain('-c');
  });

  test('an unreachable machine still gives a card with the folder', async () => {
    const { build } = builder({}, { unreachable: ['bs'] });
    const [card] = await build([pane({ machine: 'bs', branch: null })], NOW);
    expect(card).toMatchObject({ id: 'p1', folder: `${HOME}/work/app`, branch: null, origin: null });
    expect(card.stats.model).toBe(NA);
  });

  test('one failing pane does not take the others down', async () => {
    const world = localWorld();
    const { exec } = fakeExec(world);
    const flaky = async (command, args, options) => {
      if (options?.cwd === '/boom' || args?.[0]?.includes('-boom')) throw new Error('boom');
      return exec(command, args, options);
    };
    const { build } = createCardBuilder({ exec: flaky, home: HOME });
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
});

describe('card text', () => {
  const stats = { ...readStats('', null, NOW), harness: 'omp' };

  test('durations', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(NA)).toBe(NA);
  });

  test('an unlinked card shows the place and n/a for every figure', () => {
    const lines = describeCard({ id: 'p1', folder: '/work/app', branch: 'main', origin: ORIGIN, harness: 'omp', harnessName: 'omp', stats });
    expect(lines.title).toBe('omp');
    expect(lines.place).toEqual(['/work/app', 'main', ORIGIN]);
    expect(lines.rows.every(([, value]) => value === NA)).toBe(true);
  });

  test('missing git leaves out the branch and origin lines', () => {
    const lines = describeCard({ id: 'p1', folder: '/work/app', branch: null, origin: null, harness: 'omp', harnessName: 'omp', stats });
    expect(lines.place).toEqual(['/work/app']);
  });

  test('figures are formatted', () => {
    const full = {
      ...stats,
      model: 'claude-sonnet-5.5-1m',
      durationMs: 1_800_000,
      totalTokens: 60_000,
      contextPercent: 0.25,
      contextMax: 200_000,
      headroomTokens: 120_000,
      autocompactions: 2,
      cacheHitRate: 0.8,
      cacheHits: 3,
      cacheMisses: 2,
      cacheLeftMs: 180_000,
      costUsd: 0.5,
      burnCostPerHour: 2,
      burnTokensPerMin: 2000,
      sinceActivityMs: 90_000,
      latencyMs: 12_000,
      thinkingLevel: 'medium',
      premiumRequests: 7,
    };
    const rows = Object.fromEntries(describeCard({ id: 'p1', folder: '/w', branch: null, origin: null, harness: 'omp', harnessName: 'omp', stats: full }).rows);
    expect(rows).toEqual({
      Model: 'claude-sonnet-5.5-1m',
      Duration: '30m 00s',
      Tokens: '60k',
      Context: '25%/200k',
      Headroom: '120k',
      Compactions: '2',
      'Cache hit': '80% (3 hit, 2 miss)',
      'Cache left': '3m 00s',
      Cost: '$0.50',
      Burn: '$2.00/h, 2k tok/min',
      Activity: '1m 30s ago',
      Latency: '12s',
      Thinking: 'medium',
      Premium: '7',
    });
    expect(Object.keys(rows).length).toBe(14);
  });

  test('a cold cache reads cold', () => {
    const rows = Object.fromEntries(describeCard({ id: 'p', folder: '/w', branch: null, origin: null, harness: 'omp', harnessName: 'omp', stats: { ...stats, cacheLeftMs: 0 } }).rows);
    expect(rows['Cache left']).toBe('cold');
  });
});
