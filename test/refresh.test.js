import { describe, expect, test } from 'bun:test';
import { NA, readStats } from '../src/providers/index.js';
import { REFRESH_INTERVAL_MS, TAIL_BYTES, createSessionReader } from '../src/refresh.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const PATH = '/home/u/.omp/agent/sessions/--proj--/big.jsonl';

const entry = (value) => JSON.stringify(value);
const message = (role, minute, extra = {}) =>
  entry({
    type: 'message',
    id: `m${minute}`,
    timestamp: new Date(NOW - 60 * 60_000 + minute * 60_000).toISOString(),
    message: { role, provider: 'p', model: 'tail-model', content: 'x'.repeat(2000), ...extra },
  });
const compaction = (id) => entry({ type: 'compaction', id, summary: 's', tokensBefore: 1, tokensAfter: 1 });

// A session several times the tail window: its header and first compaction are far out of the
// tail's reach, the second compaction and the latest model inside it.
function bigSession() {
  const lines = [entry({ type: 'session', id: 's', timestamp: new Date(NOW - 60 * 60_000).toISOString() })];
  lines.push(compaction('c1'));
  for (let i = 0; lines.join('\n').length < TAIL_BYTES * 4; i++) lines.push(message('user', i % 50));
  lines.push(compaction('c2'));
  lines.push(message('user', 51), message('assistant', 52));
  return `${lines.join('\n')}\n`;
}

// In-memory stand-in with the exact signature of herdr's `exec(command, args, options)`:
// `tail -c N|+N -- path` and `grep -c -F pattern -- path` over a map of path -> text, like the
// real programs; anything else rejects, as a program that cannot start does. Keeps every call
// and the bytes it served: what a tail returns, or all a grep had to scan.
function fakeExec(files) {
  const calls = [];
  async function exec(command, args = [], options) {
    const call = { command, args, options, served: 0 };
    calls.push(call);
    const path = args.at(-1);
    const text = files.get(path);
    if (text === undefined) return { code: 1, stdout: '', stderr: `${command}: ${path}: No such file or directory` };
    if (command === 'tail' && args[0] === '-c') {
      const from = args[1].startsWith('+') ? Number(args[1].slice(1)) - 1 : text.length - Number(args[1]);
      const stdout = text.slice(Math.max(0, from));
      call.served = stdout.length;
      return { code: 0, stdout, stderr: '' };
    }
    if (command === 'grep' && args[0] === '-c') {
      call.served = text.length;
      const count = text.split('\n').filter((line) => line.includes(args.at(-3))).length;
      return { code: count ? 0 : 1, stdout: `${count}\n`, stderr: '' };
    }
    throw new Error(`cannot start ${command}`);
  }
  const served = (from = 0) => calls.slice(from).reduce((sum, call) => sum + call.served, 0);
  return { exec, calls, served };
}

const file = (text, mtimeMs = 1000) => ({ path: PATH, mtimeMs, size: text.length });

describe('refresh', () => {
  test('interval is 2 seconds', () => {
    expect(REFRESH_INTERVAL_MS).toBe(2000);
  });

  test('reads only the tail window', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls, served } = fakeExec(files);
    const reader = createSessionReader({ exec });

    // first refresh: the tail, and the one count over the whole file
    const input = await reader.read(file(text));
    const stats = readStats('omp', input, NOW);
    expect(text.length).toBeGreaterThan(TAIL_BYTES * 3);
    expect(input.text.length).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith(input.text)).toBe(true);
    expect(calls[0]).toMatchObject({ command: 'tail', args: ['-c', String(TAIL_BYTES), '--', PATH] });
    expect(stats.model).toBe('tail-model');
    expect(stats.autocompactions).toBe(2);

    // unchanged file: only the tail is served, nothing is counted again
    let mark = calls.length;
    expect((await reader.read(file(text))).sources.compactionCount).toBe(2);
    expect(served(mark)).toBeLessThanOrEqual(TAIL_BYTES);

    // appended lines (one holding a compaction): at most the tail plus what was appended
    const appended = `${compaction('c3')}\n${message('assistant', 53)}\n`;
    text += appended;
    files.set(PATH, text);
    mark = calls.length;
    const after = await reader.read(file(text, 2000));
    expect(served(mark)).toBeLessThanOrEqual(TAIL_BYTES + appended.length);
    expect(readStats('omp', after, NOW).autocompactions).toBe(3);
  });

  test('a half-written line is counted once it is whole', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = createSessionReader({ exec });
    await reader.read(file(text));

    const whole = `${compaction('c3')}\n`;
    text += whole.slice(0, 20);
    files.set(PATH, text);
    expect((await reader.read(file(text, 2000))).sources.compactionCount).toBe(2);
    // the cut line already holds the matched text; it must not count before its newline
    text += whole.slice(20);
    files.set(PATH, text);
    expect((await reader.read(file(text, 3000))).sources.compactionCount).toBe(3);
  });

  test('a replaced, smaller file is counted from its start', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = createSessionReader({ exec });
    await reader.read(file(text));

    const replaced = `${message('user', 2)}\n`.repeat(200);
    expect(replaced.length).toBeGreaterThan(TAIL_BYTES);
    expect(replaced.length).toBeLessThan(text.length);
    files.set(PATH, replaced);
    expect((await reader.read(file(replaced, 5000))).sources.compactionCount).toBe(0);
  });

  test('a file within the tail window is not counted', async () => {
    const text = `${entry({ type: 'session', id: 's' })}\n${compaction('c1')}\n${message('assistant', 1)}\n`;
    const { exec, calls } = fakeExec(new Map([[PATH, text]]));
    const input = await createSessionReader({ exec }).read(file(text));

    expect(calls.map((call) => call.command)).toEqual(['tail']);
    expect(readStats('omp', input, NOW).autocompactions).toBe(1);
  });

  test('no writes', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls } = fakeExec(files);
    const reader = createSessionReader({ exec });
    await reader.read(file(text));
    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    await reader.read(file(text, 2000));

    expect(calls.length).toBeGreaterThan(2);
    for (const { command, args } of calls) {
      expect(['tail', 'grep']).toContain(command);
      // no redirection, no in-place or output flag; the path follows `--`
      expect(args.filter((arg) => /^\d*>|^-i|^--in-place|^--output/.test(arg))).toEqual([]);
      expect(args.at(-2)).toBe('--');
    }
  });

  test('an unreadable file reads n/a', async () => {
    const { exec } = fakeExec(new Map());
    const input = await createSessionReader({ exec }).read({ path: PATH, mtimeMs: 1, size: 1 });
    const stats = readStats('omp', input, NOW);

    expect(stats.autocompactions).toBe(NA);
    expect(stats.model).toBe(NA);
  });
});
