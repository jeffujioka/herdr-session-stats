// Read-only refresh of a linked session file (D7): the tail of the file, and a cheap count of
// its compactions, handed to a provider as plain values. Runtime-neutral: the mod passes in
// herdr's async `exec(command, args, options)`, tests pass in a fake of the same signature.
// Only `tail` and `grep` are run; neither writes.

// The mod refreshes its cards this often (the wiring to the herdr timer is the mod's).
export const REFRESH_INTERVAL_MS = 2000;

// The most of a session file one refresh reads. A line cut at the start of the window is
// skipped by the provider, which ignores lines that are not whole JSON.
export const TAIL_BYTES = 256 * 1024;

// A tail window cannot count the compactions of the whole file, so `grep -c` counts the
// matching lines (omp writes one entry per line, in compact JSON) and returns only the number.
const COMPACTION_ENTRY = '"type":"compaction"';

// `exec`: herdr's `exec`. `read(file)` takes `{ path, mtimeMs, size }` of a linked session
// file and resolves to the `input` of `readStats('omp', input, now)`: `{ text, sources }`
// with the tail as `text` and `sources.compactionCount` the number of compactions in the file.
// A read that fails gives an empty text and no count, so every figure reads n/a (D4), and
// is tried again at the next refresh.
export function createSessionReader({ exec }) {
  // path -> { stamp, count }: the count stays valid while the file is as it was
  const counted = new Map();

  async function countCompactions({ path, mtimeMs, size }) {
    const stamp = `${mtimeMs}:${size}`;
    if (counted.get(path)?.stamp === stamp) return counted.get(path).count;
    // grep exits 1 for no match, with the count 0 printed; 2 is an error
    const { code, stdout } = await exec('grep', ['-c', '-F', COMPACTION_ENTRY, path]);
    const count = code <= 1 ? Number.parseInt(stdout, 10) : Number.NaN;
    if (!Number.isFinite(count)) return null;
    counted.set(path, { stamp, count });
    return count;
  }

  return {
    async read(file) {
      try {
        const tail = await exec('tail', ['-c', String(TAIL_BYTES), file.path]);
        if (tail.code !== 0) return { text: '', sources: {} };
        return { text: tail.stdout, sources: { compactionCount: await countCompactions(file) } };
      } catch {
        return { text: '', sources: {} };
      }
    },
  };
}
