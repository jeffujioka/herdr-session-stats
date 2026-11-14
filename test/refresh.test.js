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
// `tail -c N path` and `grep -c pattern path` over a map of path -> text, like the real
// programs; anything else rejects, as a program that cannot start does. Keeps every call.
function fakeExec(files) {
  const calls = [];
  async function exec(command, args = [], options) {
    calls.push({ command, args, options });
    const path = args.at(-1);
    const text = files.get(path);
    if (text === undefined) return { code: 1, stdout: '', stderr: `${command}: ${path}: No such file or directory` };
    if (command === 'tail' && args[0] === '-c') return { code: 0, stdout: text.slice(-Number(args[1])), stderr: '' };
    if (command === 'grep' && args[0] === '-c') {
      const count = text.split('\n').filter((line) => line.includes(args.at(-2))).length;
      return { code: count ? 0 : 1, stdout: `${count}\n`, stderr: '' };
    }
    throw new Error(`cannot start ${command}`);
  }
  return { exec, calls };
}

const file = (text, mtimeMs = 1000) => ({ path: PATH, mtimeMs, size: text.length });

describe('refresh', () => {
  test('interval is 2 seconds', () => {
    expect(REFRESH_INTERVAL_MS).toBe(2000);
  });

  test('reads only the tail window', async () => {
    const text = bigSession();
    const { exec, calls } = fakeExec(new Map([[PATH, text]]));
    const input = await createSessionReader({ exec }).read(file(text));
    const stats = readStats('omp', input, NOW);

    expect(text.length).toBeGreaterThan(TAIL_BYTES * 3);
    expect(input.text.length).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith(input.text)).toBe(true);
    const tails = calls.filter((call) => call.command === 'tail');
    expect(tails).toEqual([{ command: 'tail', args: ['-c', String(TAIL_BYTES), PATH], options: undefined }]);
    // the only other read counts matching lines and hands back the number, not the file
    expect(calls.filter((call) => call.command !== 'tail').map((call) => call.command)).toEqual(['grep']);
    // figures come from the tail; the count of both compactions from the cheap count
    expect(stats.model).toBe('tail-model');
    expect(stats.autocompactions).toBe(2);
  });

  test('counts compactions again only when the file changed', async () => {
    const text = bigSession();
    const { exec, calls } = fakeExec(new Map([[PATH, text]]));
    const reader = createSessionReader({ exec });
    const greps = () => calls.filter((call) => call.command === 'grep').length;

    await reader.read(file(text));
    await reader.read(file(text));
    expect(greps()).toBe(1);

    await reader.read(file(text, 2000));
    expect(greps()).toBe(2);
  });

  test('no writes', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls } = fakeExec(files);
    await createSessionReader({ exec }).read(file(text));

    expect(calls.length).toBeGreaterThan(0);
    for (const { command, args } of calls) {
      expect(['tail', 'grep', 'stat', 'ls']).toContain(command);
      // no redirection, no in-place or output flag
      expect(args.filter((arg) => /^\d*>|^-i|^--in-place|^--output/.test(arg))).toEqual([]);
    }
    expect(files.get(PATH)).toBe(text);
  });

  test('an unreadable file reads n/a', async () => {
    const { exec } = fakeExec(new Map());
    const input = await createSessionReader({ exec }).read({ path: PATH, mtimeMs: 1, size: 1 });
    const stats = readStats('omp', input, NOW);

    expect(stats.autocompactions).toBe(NA);
    expect(stats.model).toBe(NA);
  });
});
