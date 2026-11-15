// Pane to session link (D3). Pure and synchronous: the mod lists the session folder and hands
// the files in as plain data; this module only decides.

// The files newest-modified first (a copy; files of one time keep their order).
export function newestFirst(files) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// files: [{ path, mtimeMs }] of the pane's folder for the pane's harness. Returns the path of
// the newest-modified file, however long ago it changed (a pane with an agent has that agent
// running, so its session is the newest one; the activity figure shows how long it has been
// idle), or null when the folder has no session file (unlinked: every session figure reads
// 'n/a'; the mod never guesses a session).
export function linkSession(files) {
  return newestFirst(files)[0]?.path ?? null;
}

// The panes of one folder (one machine, one harness), in draw order, share its session files
// out. files: [{ path, mtimeMs, title? }], `title` being the session's title where the harness
// writes one into the file; paneTitles: the panes' terminal titles. Returns one file (or null,
// when there are no files) for each pane, in pane order:
//   1. a pane whose terminal title contains the non-empty title of a session gets that session,
//      the longest title first when several match; a session goes to one pane only;
//   2. the panes left, in pane order, take the newest sessions that no pane matched;
//   3. panes beyond the sessions get the newest one: they end on the same session as another
//      pane, and the cards collapse them (collapseBySession).
export function shareSessions(files, paneTitles) {
  const sorted = newestFirst(files);
  const taken = new Set();
  const titled = sorted.filter((file) => file.title).sort((a, b) => b.title.length - a.title.length);
  const shared = paneTitles.map((paneTitle) => {
    const match = titled.find((file) => !taken.has(file) && (paneTitle ?? '').includes(file.title));
    if (match) taken.add(match);
    return match ?? null;
  });
  const unmatched = sorted.filter((file) => !taken.has(file));
  return shared.map((file) => file ?? unmatched.shift() ?? sorted[0] ?? null);
}

// panes: [{ sessionPath, ... }] in draw order. Panes that link to the same session path share
// one card (the first of them); panes with no linked session (null) each keep their own.
export function collapseBySession(panes) {
  const seen = new Set();
  return panes.filter((pane) => {
    if (pane.sessionPath === null) return true;
    if (seen.has(pane.sessionPath)) return false;
    seen.add(pane.sessionPath);
    return true;
  });
}
