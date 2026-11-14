import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createCardBuilder } from '../src/cards.js';
import { TAIL_BYTES } from '../src/refresh.js';
import { sessionDirSlug } from '../src/providers/claude-sources.js';
import { NA } from '../src/providers/index.js';

const BASIC = readFileSync(new URL('./fixtures/claude/basic.jsonl', import.meta.url), 'utf8');
const HOME = '/Users/me';
const NOW = Date.parse('2026-09-07T20:22:00.000Z');
const DIR = `${HOME}/.claude/projects/-Users-me-work-app-v1-2`;

// Stand-in with the exact signature of herdr's `exec(command, args, options)` for the read-only
// programs a Claude Code card runs: `uname`, `find ... stat` over `DIR` and `tail -c N -- path`.
function fakeExec(files) {
  const calls = [];
  async function exec(command, args = [], options = {}) {
    calls.push({ command, args, options });
    const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
    if (command === 'uname') return ok('Darwin\n');
    if (command === 'find') {
      if (args[0] !== DIR) return { code: 1, stdout: '', stderr: 'No such file or directory' };
      return ok(files.map((f) => `${Math.floor(f.mtimeMs / 1000)} ${f.size} ${DIR}/${f.name}`).join('\n') + '\n');
    }
    if (command === 'tail') return ok(files.find((f) => `${DIR}/${f.name}` === args.at(-1)).text.slice(-Number(args[1])));
    return { code: 128, stdout: '', stderr: 'not a git repository' };
  }
  return { exec, calls };
}

const pane = { pane: 'p1', terminal: 't1', tab: 'tb1', title: 'claude', cwd: `${HOME}/work/app.v1_2`, branch: 'main', status: 'idle', app: 'claude-code', machine: null };

describe('claude sessions', () => {
  test('the session folder name keeps letters and digits and turns the rest into dashes', () => {
    expect(sessionDirSlug('/Users/me/work/app')).toBe('-Users-me-work-app');
    expect(sessionDirSlug('/Users/me/.claude')).toBe('-Users-me--claude');
    expect(sessionDirSlug(`${HOME}/work/app.v1_2`)).toBe('-Users-me-work-app-v1-2');
  });

  test('a Claude Code pane links to its newest recent session and reads its tail', async () => {
    const recent = { name: 'bbbb.jsonl', mtimeMs: NOW - 30_000, size: BASIC.length, text: BASIC };
    const older = { name: 'aaaa.jsonl', mtimeMs: NOW - 3_600_000, size: 10, text: 'not the session' };
    const { exec, calls } = fakeExec([older, recent]);
    const builder = createCardBuilder({ exec, readTextFile: async () => null, home: HOME });
    const [card] = await builder.build([pane], NOW);

    expect(card.harness).toBe('claude-code');
    expect(card.harnessName).toBe('Claude Code');
    expect(card.stats.model).toBe('claude-opus-4-6');
    expect(card.stats.totalTokens).toBe(180562);
    // a file no larger than the tail window is read whole, so its compactions are counted
    expect(card.stats.autocompactions).toBe(0);
    expect(calls.find((c) => c.command === 'tail').args).toEqual(['-c', String(TAIL_BYTES), '--', `${DIR}/bbbb.jsonl`]);
    for (const call of calls) expect(call.options.timeout).toBeGreaterThan(0);
  });

  test('a large session is read through its tail and its compaction count is n/a', async () => {
    const big = { name: 'cccc.jsonl', mtimeMs: NOW - 1_000, size: TAIL_BYTES * 4, text: BASIC };
    const { exec } = fakeExec([big]);
    const builder = createCardBuilder({ exec, readTextFile: async () => null, home: HOME });
    const [card] = await builder.build([pane], NOW);

    expect(card.stats.model).toBe('claude-opus-4-6');
    expect(card.stats.autocompactions).toBe(NA);
  });
});
