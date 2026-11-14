// Pane to session link (D3). Pure and synchronous: the mod lists the session folder and hands
// the files in as plain data; this module only decides.

// A session file counts for a pane only if it changed this recently.
export const LINK_WINDOW_MS = 5 * 60 * 1000;

// files: [{ path, mtimeMs }] of the pane's folder for the pane's harness; now: epoch ms.
// Returns the path of the newest-modified file if it changed within LINK_WINDOW_MS, else null
// (unlinked: every session figure reads 'n/a'; the mod never guesses a session).
export function linkSession(files, now) {
  let newest = null;
  for (const file of files) {
    if (newest === null || file.mtimeMs > newest.mtimeMs) newest = file;
  }
  if (newest === null || now - newest.mtimeMs > LINK_WINDOW_MS) return null;
  return newest.path;
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
