# herdr-session-stats

A herdr mod that shows CWD, git info and AI harness session stats per agent pane.

## How a pane is tied to a session

The mod ties a pane to a session by the pane's folder: it takes the newest-modified session
file of that folder for the pane's harness, and only if that file changed within the last
5 minutes. A folder with no session file, or only older ones, is not linked, and every
session figure on its card reads `n/a`. The mod never estimates a figure.

**Known ambiguity: two agents in one folder.** Session files are found by folder, so two
agents of the same harness running in the same folder cannot be told apart. Both panes resolve
to the newest-modified session file, so they show the same session, and the mod collapses
them into one card. The stats of the agent that wrote last are the ones shown. To keep two
agents apart, run them in different folders.
