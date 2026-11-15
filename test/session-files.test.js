import { describe, expect, test } from 'bun:test';
import { findSessionFile } from '../src/providers/session-files.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const DIR = '/home/u/.omp/agent/sessions/--proj--';

// A `find` that records its command line and prints `stat` lines for one fresh file.
function recordingExec() {
  const calls = [];
  async function exec(command, args = []) {
    calls.push({ command, args });
    return { code: 0, stdout: `${Math.floor((NOW - 1000) / 1000)} 42 ${DIR}/a.jsonl\n`, stderr: '' };
  }
  return { exec, calls };
}

// The `stat` of the command line: the program after `-exec` and its arguments up to `{}`
const statOf = (args) => args.slice(args.indexOf('-exec') + 1, args.indexOf('{}'));

describe('finding a session file', () => {
  test('on macOS the system stat is run, whatever stat comes first in PATH', async () => {
    const { exec, calls } = recordingExec();
    const file = await findSessionFile(exec, { dir: DIR, os: 'Darwin', now: NOW });

    expect(file).toEqual({ path: `${DIR}/a.jsonl`, mtimeMs: Math.floor((NOW - 1000) / 1000) * 1000, size: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('find');
    // a GNU stat first in PATH would read -f as a filesystem report
    expect(statOf(calls[0].args)).toEqual(['/usr/bin/stat', '-f', '%m %z %N']);
  });

  test('on Linux stat is GNU stat', async () => {
    const { exec, calls } = recordingExec();
    await findSessionFile(exec, { dir: DIR, os: 'Linux', now: NOW });

    expect(statOf(calls[0].args)).toEqual(['stat', '-c', '%Y %s %n']);
  });

  test('another system has no session file and runs nothing', async () => {
    const { exec, calls } = recordingExec();

    expect(await findSessionFile(exec, { dir: DIR, os: 'Plan9', now: NOW })).toBeNull();
    expect(calls).toEqual([]);
  });
});
