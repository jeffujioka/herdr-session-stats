// In-memory stand-in with the exact signature of herdr's `exec(command, args, options)` for the
// read-only programs the session reader runs over a map of path -> bytes (a Buffer or a string):
//   tail -c N -- path        the last N bytes
//   tail -c +N -- path       from byte N (1-based) to the end
//   dd if=path bs=B skip=K count=1      block K of size B, with dd's report on stderr
// Output is decoded as UTF-8 the way a real program's is (a cut character becomes U+FFFD), and
// the call's output is capped like herdr's: more than EXEC_CAP bytes makes `exec` reject. Any
// other command rejects, as a program that cannot start does. Every call is kept with the bytes
// it served, so a test can say what a refresh read.
//
// `faults`: `before(call)` runs before a call is served (a test acts on the files there);
// `fail(call)` returns true to make the call exit 1; `ddReport`: 'bsd' for BSD dd's wording,
// 'none' for a dd that reports nothing, or a function of the block's length that returns the
// statistics line (any wording).
export const EXEC_CAP = 8 * 1024 * 1024;

export function fakeExec(files, faults = {}) {
  const calls = [];
  const bytesOf = (path) => {
    const content = files.get(path);
    return typeof content === 'string' ? Buffer.from(content) : content;
  };
  async function exec(command, args = [], options) {
    const call = { command, args, options, served: 0 };
    calls.push(call);
    faults.before?.(call);
    if (faults.fail?.(call)) return { code: 1, stdout: '', stderr: `${command}: failed` };
    let path;
    let part;
    let report = '';
    if (command === 'tail' && args[0] === '-c' && args[2] === '--') {
      path = args[3];
      const bytes = bytesOf(path);
      if (bytes === undefined) return { code: 1, stdout: '', stderr: `tail: ${path}: No such file or directory` };
      part = args[1].startsWith('+') ? bytes.subarray(Number(args[1].slice(1)) - 1) : bytes.subarray(Math.max(0, bytes.length - Number(args[1])));
    } else if (command === 'dd' && args.length === 4 && args[0].startsWith('if=') && args[3] === 'count=1') {
      path = args[0].slice(3);
      const bytes = bytesOf(path);
      if (bytes === undefined) return { code: 1, stdout: '', stderr: `dd: failed to open '${path}': No such file or directory` };
      const size = Number(args[1].replace('bs=', ''));
      const skip = Number(args[2].replace('skip=', ''));
      part = bytes.subarray(skip * size, (skip + 1) * size);
      report =
        faults.ddReport === 'none'
          ? ''
          : typeof faults.ddReport === 'function'
            ? `${part.length ? 1 : 0}+0 records in\n${part.length ? 1 : 0}+0 records out\n${faults.ddReport(part.length)}\n`
            : faults.ddReport === 'bsd'
              ? `${part.length ? 1 : 0}+0 records in\n${part.length ? 1 : 0}+0 records out\n${part.length} bytes transferred in 0.001 secs (${part.length * 1000} bytes/sec)\n`
              : `${part.length ? 1 : 0}+0 records in\n${part.length ? 1 : 0}+0 records out\n${part.length} bytes (${part.length} B) copied, 0.001 s, 1.0 MB/s\n`;
    } else {
      throw new Error(`cannot start ${command}`);
    }
    if (part.length > EXEC_CAP) throw new Error('output over the exec cap');
    call.served = part.length;
    return { code: 0, stdout: part.toString('utf8'), stderr: report };
  }
  const served = (from = 0) => calls.slice(from).reduce((sum, call) => sum + call.served, 0);
  return { exec, calls, served };
}
