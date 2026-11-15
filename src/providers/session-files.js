// Finding a harness's session files and keeping the readers of them: shared by the providers'
// `createSessions` hooks. Runtime-neutral: it takes the app's `exec` bound to a machine and runs
// only `find` with `stat`, and `tail` and `dd` through the session reader (src/refresh.js).

import { createSessionReader } from '../refresh.js';
import { linkSession } from '../session-link.js';

// `readerOn(machine)` of one hook: the reader that keeps that machine's per-file totals, made
// on first use. `execOn(machine)` is the app's `exec` bound to a machine, `fold` the provider's.
export function sessionReaders(execOn, fold) {
  const readers = new Map();
  return (machine) => {
    if (!readers.has(machine)) readers.set(machine, createSessionReader({ exec: execOn(machine), fold }));
    return readers.get(machine);
  };
}

// Lines of `stat` as `<mtime seconds> <size> <path>`; anything else is skipped.
export function parseSessionFiles(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\d+) (\d+) (.+)$/.exec(line);
    if (match) files.push({ path: match[3], mtimeMs: Number(match[1]) * 1000, size: Number(match[2]) });
  }
  return files;
}

// `stat` prints its format differently on BSD (macOS) and GNU (Linux); `uname -s` says which.
// The program is named with the format: on macOS a GNU `stat` first in PATH (coreutils from
// Homebrew) would read `-f` as a filesystem report, so the system's own is run by its path.
const STAT_COMMANDS = {
  Darwin: ['/usr/bin/stat', '-f', '%m %z %N'],
  Linux: ['stat', '-c', '%Y %s %n'],
};

// The session file in `dir` (only the `.jsonl` files directly in it) that the pane links to
// (see session-link.js), as `{ path, mtimeMs, size }`, or null.
export async function findSessionFile(exec, { dir, os, now }) {
  const stat = STAT_COMMANDS[os];
  if (!stat) return null;
  const listed = await exec('find', [dir, '-maxdepth', '1', '-name', '*.jsonl', '-exec', ...stat, '{}', '+']);
  if (listed.code !== 0) return null;
  const files = parseSessionFiles(listed.stdout);
  const path = linkSession(files, now);
  return files.find((file) => file.path === path) ?? null;
}
