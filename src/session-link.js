// Pane to session link (D3). Pure and synchronous: the mod lists the session folder and hands
// the files in as plain data; this module only decides.

// files: [{ path, mtimeMs }] of the pane's folder for the pane's harness. Returns the path of
// the newest-modified file, however long ago it changed (a pane with an agent has that agent
// running, so its session is the newest one; the activity figure shows how long it has been
// idle), or null when the folder has no session file (unlinked: every session figure reads
// 'n/a'; the mod never guesses a session).
export function linkSession(files) {
  let newest = null;
  for (const file of files) {
    if (newest === null || file.mtimeMs > newest.mtimeMs) newest = file;
  }
  return newest === null ? null : newest.path;
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
