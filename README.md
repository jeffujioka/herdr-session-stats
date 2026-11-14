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

## Install

`bun scripts/install.js [--home <dir>]` builds the mod (`scripts/sync.sh`, which also runs
`herdr-app check`) and installs it into a herdr home (`--home`, else `HERDR_APP_HOME`, else
`~/.config/herdr-app`). It never edits the layout you use:

- the mod folder is copied to `mods/herdr-session-stats`;
- your active layout (what `herdr-app status` says is shown, else `layout` in `shared.json`)
  is cloned as `<active>-stats`, with the docked block added as a new right-hand column. Show
  it with `herdr-app do layout.switch --name <active>-stats`;
- `ctrl-shift-s` is bound to `layout.toggle` on the docked block, in the clone's `layout:`
  section of `keys.json`. Your bindings are kept; if the key is already taken (in that
  section, in `global` or in `terminal`) the install says so and leaves it unbound.

Run again, it changes nothing. An existing clone is completed, never rebuilt, so edits you made
to it stay.
