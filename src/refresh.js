// Read-only refresh of a linked session file (D7): the tail window of the file for the card,
// and a state over the whole file for the session totals (the accumulator of the provider's
// `fold`), both handed to a provider as plain values. Runtime-neutral: the mod passes in
// herdr's async `exec(command, args, options)` (`{ code, stdout, stderr }`), tests pass in a
// fake of the same signature. Only `tail` and `dd` are run; neither writes, and no shell
// string or redirection is used.

import { parseEntries } from './providers/jsonl.js';

// The mod refreshes its cards this often (the wiring to the herdr timer is the mod's).
export const REFRESH_INTERVAL_MS = 2000;

// The most of a session file one refresh reads for the figures about its end. A line cut at
// the start of the window is skipped by the provider, which ignores lines that are not whole
// JSON.
export const TAIL_BYTES = 256 * 1024;

// The most of a file one read of the first scan takes: within herdr's 8 MiB `exec` output.
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

// herdr's runtime has no TextEncoder: the byte length of a string in UTF-8 is counted from its
// UTF-16 code units. A surrogate pair is one 4-byte character; a lone surrogate is 3 bytes, the
// U+FFFD TextEncoder would write for it.
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// What a scan of a file has covered: `state`, the provider's accumulator over the whole lines
// of the file's first bytes. While the first pass is under way (`pos` is -1) those bytes are
// the blocks before `block`, and `carry` is the text read after the last newline of them, a
// line not whole yet. Once it is done, `pos` is the number of bytes covered, which is where
// the last whole line ends (the next byte begins a line).
const newScan = () => ({ state: undefined, block: 0, carry: '', pos: -1 });

// `exec`: herdr's `exec`. `fold(state, entries)`: the provider's accumulator (see
// src/providers/omp.js). `read(file)` takes `{ path, mtimeMs, size }` of a linked session file
// and resolves to the `input` of `readStats(harness, input, now)`: `{ text, sources, state }`
// with the tail window as `text`. A file no larger than the window is read whole by it, so
// `sources.wholeFile` is true and the provider folds the text; a larger one gets a `state`
// over the whole file (see `advance`), or `null` when it could not be built, so that every
// figure of the session totals reads n/a (D4) and is tried again at the next refresh. A read
// that fails gives an empty text and no state, so every figure reads n/a.
export function createSessionReader({ exec, fold }) {
  // path -> the scan of that file
  const scans = new Map();
  // path -> the last scan step of that file: panes of one file ask at once, and two steps on
  // one scan would fold the same bytes twice
  const queues = new Map();

  // The state of the file's first `size` bytes or more, read as little as possible:
  //
  // - The first sight of a file is one read-only pass over all of it, in blocks of
  //   `SCAN_CHUNK_BYTES` by `dd` (the block `skip` of size `bs`, exactly), each within herdr's
  //   output cap. A block ends anywhere, so the text of one is cut at its last newline, the
  //   lines before it are folded and the rest carried to the next block: no line is split. A
  //   character that a block boundary cuts reads as U+FFFD at both ends of the carried line;
  //   that can only change text inside a JSON string, never a figure.
  //   The pass ends at the first short block. `dd` reports the bytes it copied, which is the
  //   exact length of the block; the covered bytes end where the carried line begins.
  // - Afterwards only what was appended: `tail -c +<pos>` starts at the last covered byte, a
  //   newline, so the text after it begins a line, and its whole lines are folded; `pos`
  //   advances by their UTF-8 length. A line being written is left for the next refresh, when
  //   it is whole. Starting one byte early checks the bookkeeping: anything but a newline
  //   there means the file is not what was scanned, and it is scanned again.
  // - A smaller file than scanned was replaced, so the scan starts over, as it does when more
  //   was appended than one read can take.
  //
  // A read that fails leaves the scan as it was (a chunk is folded only once read), so the next
  // refresh goes on from there, and throws.
  async function advance(path, size) {
    let scan = scans.get(path);
    if (scan && (size < (scan.pos >= 0 ? scan.pos : scan.block * SCAN_CHUNK_BYTES) || scan.pos === 0)) scan = undefined;
    if (scan?.pos >= 0) {
      if (size === scan.pos) return scan.state;
      if (size - scan.pos <= SCAN_CHUNK_BYTES) {
        const added = await exec('tail', ['-c', `+${scan.pos}`, '--', path]);
        if (added.code !== 0) throw new Error(`tail failed on ${path}`);
        if (added.stdout.startsWith('\n')) {
          const rest = added.stdout.slice(1);
          const whole = rest.slice(0, rest.lastIndexOf('\n') + 1);
          scan.state = fold(scan.state, parseEntries(whole));
          scan.pos += utf8Length(whole);
          return scan.state;
        }
      }
      scan = undefined;
    }
    if (!scan) {
      scan = newScan();
      scans.set(path, scan);
    }
    while (scan.pos < 0) {
      const block = await exec('dd', [`if=${path}`, `bs=${SCAN_CHUNK_BYTES}`, `skip=${scan.block}`, 'count=1']);
      const copied = /^(\d+) bytes/m.exec(block.stderr ?? '');
      if (block.code !== 0 || !copied) throw new Error(`dd failed on ${path}`);
      const text = scan.carry + block.stdout;
      const cut = text.lastIndexOf('\n') + 1;
      scan.state = fold(scan.state, parseEntries(text.slice(0, cut)));
      scan.carry = text.slice(cut);
      const length = Number(copied[1]);
      if (length < SCAN_CHUNK_BYTES) {
        scan.pos = scan.block * SCAN_CHUNK_BYTES + length - utf8Length(scan.carry);
        scan.carry = '';
      }
      scan.block += 1;
    }
    return scan.state;
  }

  const queued = (path, work) => {
    const next = (queues.get(path) ?? Promise.resolve()).then(work);
    queues.set(path, next.catch(() => {}));
    return next;
  };

  return {
    async read(file) {
      try {
        const tail = await exec('tail', ['-c', String(TAIL_BYTES), '--', file.path]);
        if (tail.code !== 0) {
          scans.delete(file.path);
          return { text: '', sources: {} };
        }
        if (file.size <= TAIL_BYTES) {
          scans.delete(file.path);
          return { text: tail.stdout, sources: { wholeFile: true } };
        }
        const state = await queued(file.path, () => advance(file.path, file.size)).catch(() => null);
        return { text: tail.stdout, sources: {}, state };
      } catch {
        scans.delete(file.path);
        return { text: '', sources: {} };
      }
    },
  };
}
