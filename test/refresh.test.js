import { describe, expect, test } from 'bun:test';
import { NA, readStats } from '../src/providers/index.js';
import { ompProvider } from '../src/providers/omp.js';
import { REFRESH_INTERVAL_MS, SCAN_CHUNK_BYTES, TAIL_BYTES, createSessionReader } from '../src/refresh.js';
import { fakeExec } from './helpers/fake-exec.js';

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

const file = (text, mtimeMs = 1000) => ({ path: PATH, mtimeMs, size: Buffer.byteLength(text) });
const newReader = (exec) => createSessionReader({ exec, fold: ompProvider.fold });
// the autocompactions of a read, which is what the whole-file count shows as
const counted = async (reader, f) => readStats('omp', await reader.read(f), NOW).autocompactions;

describe('refresh', () => {
  test('interval is 2 seconds', () => {
    expect(REFRESH_INTERVAL_MS).toBe(2000);
  });

  test('reads only the tail window', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls, served } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text)); // the one-off first scan is not a refresh of this scenario

    // a refresh of a file far larger than the window, with lines appended: the tail, plus the
    // appended bytes (and the newline before them, which checks where they begin), and never
    // the whole file
    const appended = `${compaction('c3')}\n${message('assistant', 53)}\n`;
    text += appended;
    files.set(PATH, text);
    const mark = calls.length;
    const input = await reader.read(file(text, 2000));

    expect(text.length).toBeGreaterThan(TAIL_BYTES * 3);
    expect(input.text.length).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith(input.text)).toBe(true);
    expect(calls[mark]).toMatchObject({ command: 'tail', args: ['-c', String(TAIL_BYTES), '--', PATH] });
    expect(served(mark)).toBeLessThanOrEqual(TAIL_BYTES + appended.length + 1);
  });

  test('the first refresh counts the whole file once', async () => {
    const text = bigSession();
    const { exec, calls } = fakeExec(new Map([[PATH, text]]));
    const reader = newReader(exec);
    const stats = readStats('omp', await reader.read(file(text)), NOW);

    // the second compaction is in the tail, the first only in the whole-file state
    expect(stats.model).toBe('tail-model');
    expect(stats.autocompactions).toBe(2);

    // an unchanged file is counted from the state: no more than the tail is served
    const mark = calls.length;
    expect(await counted(reader, file(text))).toBe(2);
    expect(calls.slice(mark).map((call) => call.command)).toEqual(['tail']);
  });

  test('appended compactions are added to the count', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    text += `${compaction('c3')}\n${message('assistant', 53)}\n`;
    files.set(PATH, text);
    expect(await counted(reader, file(text, 2000))).toBe(3);
  });

  test('a line appended after the listing is not counted twice', async () => {
    const listed = bigSession();
    const grown = `${listed}${compaction('c3')}\n`;
    const files = new Map([[PATH, listed]]);
    // the file grows between the lister's stat and the scan
    const { exec } = fakeExec(files, { before: (call) => call.command === 'dd' && files.set(PATH, grown) });
    const reader = newReader(exec);

    // the scan reads what is there, the new line included; the next refresh starts after it
    expect(await counted(reader, file(listed))).toBe(3);
    expect(await counted(reader, file(grown, 2000))).toBe(3);
  });

  test('a failed incremental read recounts from the start', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const faults = {};
    const { exec, calls } = fakeExec(files, faults);
    const reader = newReader(exec);
    await reader.read(file(text));

    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    faults.fail = (call) => call.command === 'tail' && call.args[1].startsWith('+');
    const failed = await reader.read(file(text, 2000));
    expect(failed.state).toBe(null);
    expect(readStats('omp', failed, NOW).autocompactions).toBe(NA);
    // the tail still gives the figures about the end of the file
    expect(readStats('omp', failed, NOW).model).toBe('tail-model');

    // nothing was folded from the failed read, so the next refresh goes on from where the
    // scan stood: the count is whole again without reading the file a second time
    faults.fail = null;
    const scans = () => calls.filter((call) => call.command === 'dd').length;
    const before = scans();
    expect(await counted(reader, file(text, 3000))).toBe(3);
    expect(scans()).toBe(before);
  });

  test('a dd that did not exit is not a count of 0', async () => {
    const text = bigSession();
    const faults = { fail: (call) => call.command === 'dd' };
    const { exec, calls } = fakeExec(new Map([[PATH, text]]), faults);
    const reader = newReader(exec);

    const failed = await reader.read(file(text));
    expect(failed.state).toBe(null);
    expect(readStats('omp', failed, NOW).autocompactions).toBe(NA);
    expect(readStats('omp', failed, NOW).totalTokens).toBe(NA);

    // nothing was kept: the next refresh scans the file again
    faults.fail = null;
    expect(await counted(reader, file(text))).toBe(2);
    expect(calls.filter((call) => call.command === 'dd')).toHaveLength(2);
  });

  test('a scan whose dd does not say how much it copied is no state', async () => {
    const text = bigSession();
    const { exec } = fakeExec(new Map([[PATH, text]]), { ddReport: 'none' });
    const input = await newReader(exec).read(file(text));

    expect(input.state).toBe(null);
    expect(readStats('omp', input, NOW).autocompactions).toBe(NA);
  });

  test("a BSD dd's report is read the same", async () => {
    const text = bigSession();
    const { exec } = fakeExec(new Map([[PATH, text]]), { ddReport: 'bsd' });

    expect(await counted(newReader(exec), file(text))).toBe(2);
  });

  test('a half-written line is counted once it is whole', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    const whole = `${compaction('c3')}\n`;
    text += whole.slice(0, 20);
    files.set(PATH, text);
    expect(await counted(reader, file(text, 2000))).toBe(2);
    // the cut line already holds the matched text; it must not count before its newline
    text += whole.slice(20);
    files.set(PATH, text);
    expect(await counted(reader, file(text, 3000))).toBe(3);
  });

  test('the scanned size advances by UTF-8 bytes, not characters', async () => {
    // the files are byte-accurate Buffers, `tail -c +N` starts at byte N and `dd` reports bytes,
    // as the real programs do
    let bytes = Buffer.from(bigSession());
    const files = new Map([[PATH, bytes]]);
    const { exec, calls } = fakeExec(files);
    const reader = newReader(exec);
    const listed = () => ({ path: PATH, mtimeMs: 1000, size: bytes.length });
    expect(await counted(reader, listed())).toBe(2);

    // é is 2 bytes, 漢 is 3, 😀 is 4 (two UTF-16 units): each appended line is longer in bytes
    // than in characters, and a wrong advance would start the next read inside the last line
    // and count it again
    for (const [n, id] of ['c3', 'c4', 'c5'].entries()) {
      bytes = Buffer.concat([bytes, Buffer.from(`${entry({ type: 'compaction', id, summary: 'é漢😀'.repeat(10) })}\n`)]);
      files.set(PATH, bytes);
      expect(await counted(reader, listed())).toBe(3 + n);
    }
    // never scanned again: the advance stayed right
    expect(calls.filter((call) => call.command === 'dd')).toHaveLength(1);
  });

  test('a replaced, smaller file is counted from its start', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    const replaced = `${message('user', 2)}\n`.repeat(200);
    expect(replaced.length).toBeGreaterThan(TAIL_BYTES);
    expect(replaced.length).toBeLessThan(text.length);
    files.set(PATH, replaced);
    expect(await counted(reader, file(replaced, 5000))).toBe(0);
  });

  test('a file that is not what was scanned is scanned again', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    // a larger file whose byte before the scanned size is not a newline: one line of 'y'
    // as long as the old file, then a compaction
    const replaced = `${'y'.repeat(text.length)}\n${compaction('o3')}\n`;
    files.set(PATH, replaced);
    const mark = calls.length;
    expect(await counted(reader, file(replaced, 5000))).toBe(1);
    expect(calls.slice(mark).some((call) => call.command === 'dd')).toBe(true);
  });

  test('panes of one file asking at once fold its lines once', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    const grown = `${text}${compaction('c3')}\n`;
    files.set(PATH, grown);
    const reads = await Promise.all([reader.read(file(grown, 2000)), reader.read(file(grown, 2000)), reader.read(file(grown, 2000))]);
    for (const input of reads) expect(readStats('omp', input, NOW).autocompactions).toBe(3);
  });

  test('a file within the tail window is not counted', async () => {
    const text = `${entry({ type: 'session', id: 's' })}\n${compaction('c1')}\n${message('assistant', 1)}\n`;
    const { exec, calls } = fakeExec(new Map([[PATH, text]]));
    const input = await newReader(exec).read(file(text));

    expect(calls.map((call) => call.command)).toEqual(['tail']);
    expect(readStats('omp', input, NOW).autocompactions).toBe(1);
  });

  test('a first scan takes blocks within the chunk size', () => {
    expect(SCAN_CHUNK_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test('no writes', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls } = fakeExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));
    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    await reader.read(file(text, 2000));

    expect(calls.length).toBeGreaterThan(2);
    for (const { command, args } of calls) {
      expect(['tail', 'dd']).toContain(command);
      // no redirection, no output operand or flag
      expect(args.filter((arg) => /^\d*>|^of=|^-i|^--in-place|^--output/.test(arg))).toEqual([]);
      // the path follows `--`, or is the `if=` operand of dd
      if (command === 'tail') expect(args.at(-2)).toBe('--');
      else expect(args[0]).toBe(`if=${PATH}`);
    }
  });

  test('an unreadable file reads n/a', async () => {
    const { exec } = fakeExec(new Map());
    const input = await newReader(exec).read({ path: PATH, mtimeMs: 1, size: 1 });
    const stats = readStats('omp', input, NOW);

    expect(stats.autocompactions).toBe(NA);
    expect(stats.model).toBe(NA);
  });
});
