// The Claude Code side of a card's I/O: where Claude Code keeps a folder's sessions, and the
// text of one (src/providers/claude.js reads only values handed in). It is the Claude Code
// provider's `createSessions` hook (see the stats-shape header of src/providers/index.js).
// Runtime-neutral: it takes the app's `exec` bound to a machine, and runs only read-only
// programs there: `find` with `stat`, and `tail`.

import { TAIL_BYTES } from '../refresh.js';
import { linkSession } from '../session-link.js';
import { parseSessionFiles } from './omp-sources.js';

// Name of Claude Code's session folder for a working folder (docs/claude-session-format.md):
// the path with every character that is not a letter or a digit turned into `-`. Claude Code
// shortens a very long name with a hash, which the mod does not reproduce: such a folder has
// no linked session, so its card reads n/a.
export function sessionDirSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// `stat` prints its format differently on BSD (macOS) and GNU (Linux); `uname -s` says which.
const STAT_FORMATS = {
  Darwin: ['-f', '%m %z %N'],
  Linux: ['-c', '%Y %s %n'],
};

// `execOn(machine)`: the app's `exec` bound to a machine (null: this computer), with its timeout.
export function createClaudeSessions({ execOn }) {
  return {
    // The session file the pane's folder links to (`{ path, mtimeMs, size }`), or null. Only
    // the files directly in the folder are sessions; the folders beside them hold sub-agent data.
    async link({ machine, cwd, home, os, now }) {
      const format = STAT_FORMATS[os];
      if (!format) return null;
      const dir = `${home}/.claude/projects/${sessionDirSlug(cwd)}`;
      const listed = await execOn(machine)('find', [dir, '-maxdepth', '1', '-name', '*.jsonl', '-exec', 'stat', ...format, '{}', '+']);
      if (listed.code !== 0) return null;
      const files = parseSessionFiles(listed.stdout);
      const path = linkSession(files, now);
      return files.find((file) => file.path === path) ?? null;
    },

    // The `input` of `readStats('claude-code', input, now)` for a linked file: its tail window,
    // which is the whole file when it is no larger.
    async read(file, { machine }) {
      const tail = await execOn(machine)('tail', ['-c', String(TAIL_BYTES), '--', file.path]);
      if (tail.code !== 0) throw new Error(`tail failed on ${file.path}`);
      return { text: tail.stdout, sources: { wholeFile: file.size <= TAIL_BYTES } };
    },
  };
}
