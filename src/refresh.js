// Read-only refresh of a linked session file (D7): the tail of the file, and a count of its
// compactions kept up to date from the bytes appended since, handed to a provider as plain
// values. Runtime-neutral: the mod passes in herdr's async `exec(command, args, options)`
// (`{ code, stdout, stderr }`), tests pass in a fake of the same signature. Only `tail` and
// `grep` are run; neither writes, and no shell string or redirection is used.

// The mod refreshes its cards this often (the wiring to the herdr timer is the mod's).
export const REFRESH_INTERVAL_MS = 2000;

// The most of a session file one refresh reads for its figures. A line cut at the start of
// the window is skipped by the provider, which ignores lines that are not whole JSON.
export const TAIL_BYTES = 256 * 1024;

// omp writes one entry per line, in compact JSON.
const COMPACTION_ENTRY = '"type":"compaction"';

const encoder = new TextEncoder();

// `exec`: herdr's `exec`. `read(file)` takes `{ path, mtimeMs, size }` of a linked session
// file and resolves to the `input` of `readStats('omp', input, now)`: `{ text, sources }`
// with the tail as `text`. A file no larger than the tail window is read whole by it, header
// included, so the provider counts from the text. A larger one gets `sources.compactionCount`:
// counted over the whole file once, then only over the bytes appended since (see
// `countCompactions`). A read that fails gives an empty text and no count, so every figure
// reads n/a (D4), and is tried again at the next refresh.
export function createSessionReader({ exec }) {
  // path -> { count, scannedSize }: compactions in the first `scannedSize` bytes of the file
  const counted = new Map();

  // The first count of a file is one read-only pass over all of it: `grep -b -o` prints one
  // short `offset:match` line per compaction, so no file content enters the mod. Only the
  // matches that start below the size the lister saw count, and `scannedSize` is that size:
  // a line appended between the listing and the pass lies past it and is counted by the
  // next incremental read, not twice. Afterwards each refresh reads only what was appended
  // past `scannedSize`, and advances it up to the last newline so a half-written line is
  // counted once it is whole. A match that starts below the size but is cut by it (a line
  // being written) is counted here, and the incremental read, which starts inside it, does not
  // see it again. A smaller file than scanned was replaced, so the count starts over.
  async function countCompactions({ path, size }) {
    if (size <= TAIL_BYTES) {
      counted.delete(path);
      return null;
    }
    const seen = counted.get(path);
    if (seen && size >= seen.scannedSize) {
      if (size === seen.scannedSize) return seen.count;
      const added = await exec('tail', ['-c', `+${seen.scannedSize + 1}`, '--', path]);
      if (added.code !== 0) {
        counted.delete(path);
        return null;
      }
      const whole = added.stdout.slice(0, added.stdout.lastIndexOf('\n') + 1);
      seen.count += whole.split(COMPACTION_ENTRY).length - 1;
      seen.scannedSize += encoder.encode(whole).length;
      return seen.count;
    }
    // grep exits 1 for no match, with nothing printed; any other code (2, or none or a
    // negative one for a process that was signalled) is a failed count
    const { code, stdout } = await exec('grep', ['-b', '-o', '-F', COMPACTION_ENTRY, '--', path]);
    if (code !== 0 && code !== 1) return null;
    const count = stdout.split('\n').filter((line) => line && Number.parseInt(line, 10) < size).length;
    counted.set(path, { count, scannedSize: size });
    return count;
  }

  return {
    async read(file) {
      try {
        const tail = await exec('tail', ['-c', String(TAIL_BYTES), '--', file.path]);
        if (tail.code !== 0) return { text: '', sources: {} };
        return { text: tail.stdout, sources: { compactionCount: await countCompactions(file) } };
      } catch {
        counted.delete(file.path);
        return { text: '', sources: {} };
      }
    },
  };
}
