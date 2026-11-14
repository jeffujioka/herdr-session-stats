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
// `tail -c N|+N -- path` and `grep -b -o -F pattern -- path` (`offset:match` per match) over a
// map of path -> text, like the real programs; anything else rejects, as a program that cannot
// start does. Keeps every call and the bytes it served: what a tail returns, or all a grep had
// to scan. `faults` lets a test act before a grep runs (`beforeGrep`) or fail every
// incremental tail (`failIncremental`).
function fakeExec(files, faults = {}) {
  const calls = [];
  async function exec(command, args = [], options) {
    const call = { command, args, options, served: 0 };
    calls.push(call);
    if (command === 'grep') faults.beforeGrep?.();
    if (command === 'grep' && 'grepCode' in faults) return { code: faults.grepCode, stdout: '', stderr: '' };
    const path = args.at(-1);
    const text = files.get(path);
    if (text === undefined) return { code: 1, stdout: '', stderr: `${command}: ${path}: No such file or directory` };
    if (command === 'tail' && args[0] === '-c') {
      if (faults.failIncremental && args[1].startsWith('+')) return { code: 1, stdout: '', stderr: 'tail: failed' };
      const from = args[1].startsWith('+') ? Number(args[1].slice(1)) - 1 : text.length - Number(args[1]);
      const stdout = text.slice(Math.max(0, from));
      call.served = stdout.length;
      return { code: 0, stdout, stderr: '' };
    }
    if (command === 'grep' && args[0] === '-b' && args[1] === '-o') {
      call.served = text.length;
      const pattern = args.at(-3);
      const found = [];
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) found.push(`${at}:${pattern}\n`);
      return { code: found.length ? 0 : 1, stdout: found.join(''), stderr: '' };
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
    await reader.read(file(text)); // the one-off first count is not a refresh of this scenario

    // a refresh of a file far larger than the window, with lines appended: the tail, plus the
    // appended bytes for the count, and never the whole file
    const appended = `${compaction('c3')}\n${message('assistant', 53)}\n`;
    text += appended;
    files.set(PATH, text);
    const mark = calls.length;
    const input = await reader.read(file(text, 2000));

    expect(text.length).toBeGreaterThan(TAIL_BYTES * 3);
    expect(input.text.length).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith(input.text)).toBe(true);
    expect(calls[mark]).toMatchObject({ command: 'tail', args: ['-c', String(TAIL_BYTES), '--', PATH] });
    expect(served(mark)).toBeLessThanOrEqual(TAIL_BYTES + appended.length);
  });

  test('the first refresh counts the whole file once', async () => {
    const text = bigSession();
    const { exec, calls } = fakeExec(new Map([[PATH, text]]));
    const reader = createSessionReader({ exec });
    const stats = readStats('omp', await reader.read(file(text)), NOW);

    // the second compaction is in the tail, the first only in the count
    expect(stats.model).toBe('tail-model');
    expect(stats.autocompactions).toBe(2);

    // an unchanged file is counted from the cache: no more than the tail is served
    const mark = calls.length;
    expect((await reader.read(file(text))).sources.compactionCount).toBe(2);
    expect(calls.slice(mark).map((call) => call.command)).toEqual(['tail']);
  });

  test('appended compactions are added to the count', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = createSessionReader({ exec });
    await reader.read(file(text));

    text += `${compaction('c3')}\n${message('assistant', 53)}\n`;
    files.set(PATH, text);
    expect((await reader.read(file(text, 2000))).sources.compactionCount).toBe(3);
  });

  test('a line appended after the listing is not counted twice', async () => {
    const listed = bigSession();
    const grown = `${listed}${compaction('c3')}\n`;
    const files = new Map([[PATH, listed]]);
    // the file grows between the lister's stat and the grep
    const { exec } = fakeExec(files, { beforeGrep: () => files.set(PATH, grown) });
    const reader = createSessionReader({ exec });

    expect((await reader.read(file(listed))).sources.compactionCount).toBe(2);
    expect((await reader.read(file(grown, 2000))).sources.compactionCount).toBe(3);
  });

  test('a failed incremental read recounts from the start', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const faults = {};
    const { exec, calls } = fakeExec(files, faults);
    const reader = createSessionReader({ exec });
    await reader.read(file(text));

    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    faults.failIncremental = true;
    const failed = await reader.read(file(text, 2000));
    expect(failed.sources.compactionCount).toBe(null);
    expect(readStats('omp', failed, NOW).autocompactions).toBe(NA);

    faults.failIncremental = false;
    const greps = () => calls.filter((call) => call.command === 'grep').length;
    const before = greps();
    expect((await reader.read(file(text, 3000))).sources.compactionCount).toBe(3);
    expect(greps()).toBe(before + 1);
  });

  test('a grep that did not exit is not a count of 0', async () => {
    const text = bigSession();
    const faults = { grepCode: null }; // a process that was signalled has no exit code
    const { exec, calls } = fakeExec(new Map([[PATH, text]]), faults);
    const reader = createSessionReader({ exec });

    const failed = await reader.read(file(text));
    expect(failed.sources.compactionCount).toBe(null);
    expect(readStats('omp', failed, NOW).autocompactions).toBe(NA);

    // nothing was cached: the next refresh counts the file again
    delete faults.grepCode;
    expect((await reader.read(file(text))).sources.compactionCount).toBe(2);
    expect(calls.filter((call) => call.command === 'grep')).toHaveLength(2);
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

  test('the scanned size advances by UTF-8 bytes, not characters', async () => {
    // a byte-accurate stand-in: the file is a Buffer, `tail -c +N` starts at byte N and
    // `grep -b` prints byte offsets, as the real programs do
    let bytes = Buffer.from(bigSession());
    async function exec(command, args) {
      if (command === 'tail') {
        const from = args[1].startsWith('+') ? Number(args[1].slice(1)) - 1 : Math.max(0, bytes.length - Number(args[1]));
        return { code: 0, stdout: bytes.subarray(from).toString('utf8'), stderr: '' };
      }
      const pattern = Buffer.from(args.at(-3));
      const found = [];
      for (let at = bytes.indexOf(pattern); at >= 0; at = bytes.indexOf(pattern, at + 1)) found.push(`${at}:${args.at(-3)}\n`);
      return { code: found.length ? 0 : 1, stdout: found.join(''), stderr: '' };
    }
    const reader = createSessionReader({ exec });
    const listed = () => ({ path: PATH, mtimeMs: 1000, size: bytes.length });
    expect((await reader.read(listed())).sources.compactionCount).toBe(2);

    // é is 2 bytes, 漢 is 3, 😀 is 4 (two UTF-16 units): each appended line is longer in bytes
    // than in characters, and a wrong advance would start the next read inside the last line
    // and count it again
    for (const [n, id] of ['c3', 'c4', 'c5'].entries()) {
      bytes = Buffer.concat([bytes, Buffer.from(`${entry({ type: 'compaction', id, summary: 'é漢😀'.repeat(10) })}\n`)]);
      expect((await reader.read(listed())).sources.compactionCount).toBe(3 + n);
    }
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
