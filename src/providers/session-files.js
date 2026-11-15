// Finding a harness's session files: shared by the providers' `createSessions` hooks.
// Runtime-neutral: it takes the app's `exec` bound to a machine and runs only `find` with `stat`.

import { linkSession } from '../session-link.js';

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
const STAT_FORMATS = {
  Darwin: ['-f', '%m %z %N'],
  Linux: ['-c', '%Y %s %n'],
};

// The session file in `dir` (only the `.jsonl` files directly in it) that the pane links to
// (see session-link.js), as `{ path, mtimeMs, size }`, or null.
export async function findSessionFile(exec, { dir, os, now }) {
  const format = STAT_FORMATS[os];
  if (!format) return null;
  const listed = await exec('find', [dir, '-maxdepth', '1', '-name', '*.jsonl', '-exec', 'stat', ...format, '{}', '+']);
  if (listed.code !== 0) return null;
  const files = parseSessionFiles(listed.stdout);
  const path = linkSession(files, now);
  return files.find((file) => file.path === path) ?? null;
}
