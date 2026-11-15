# herdr-session-stats

A herdr mod that shows CWD, git info and AI harness session stats per agent pane.

## What a card shows

One card per agent pane of the shown space (a terminal in which herdr detected omp, Claude Code
or opencode, in any tab of that space; panes of other spaces get none), in pane order,
refreshed every 2 seconds from read-only reads of the harness's own session files
(opencode: its database). A card has the harness name, the pane's folder, its git branch and
origin, and these rows:

| Row | Meaning |
| --- | --- |
| Model | model of the latest reply |
| Duration | first to last message of the session |
| Tokens | tokens used by the session |
| Context | context used, as a share of the model's window, and the window (`25%/200k`) |
| Headroom | tokens left before the harness autocompacts |
| Compactions | compactions recorded in the session |
| Cache hit | share of prompt tokens served from the cache, and the turns that hit or missed it |
| Cache left | time until the prompt cache is cold (`cold` once it is) |
| Cost | cost the harness logged; there is no price table |
| Burn | cost per hour and tokens per minute of the session |
| Activity | time since the last message |
| Latency | last turn: the reply minus the message that began it |
| Thinking | thinking level of the session |
| Premium | premium requests used |

A figure the session does not give reads `n/a`; the mod never estimates one, and a harness
that does not log a figure reads `n/a` for it.

## Keys

The install binds three keys, one for each way to show the same mod (see Install):

- `f7` toggles the docked block, a column on the right with the full cards;
- `f8` toggles the drawer, a floating block on the right edge that peeks; its cards
  are compact rows with the context used and the cost first, which show while it peeks;
- `f9` opens the popup, a larger dialog that draws each card roomy; pressed again it
  closes.

On a Mac keyboard F7-F9 can be media keys: press Fn with them, or turn on "Use F1, F2, etc.
keys as standard function keys" in the keyboard settings.

## How a pane is tied to a session

The mod ties a pane to a session by the pane's folder: it takes the newest-modified session
file of that folder for the pane's harness, however long ago it changed. A pane with an agent
has that agent running, so its session is the newest one, and an idle session shows its figures
and its idle time (the Activity row). A folder with no session file is not linked, and every
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

- the mod folder is copied to `mods/herdr-session-stats` (hidden files, `node_modules` and the
  files the app writes there are left alone). The mod asks herdr for no place of its own
  (`"place": "none"`), so herdr does not dock it into the layout you are looking at;
- your active layout (what `herdr-app status` says is shown, else `layout` in `shared.json`)
  is cloned as `<active>-stats`, with the docked block added as a new right-hand column and
  the drawer as a floating block on the right edge that peeks. Its root must be a row, as in
  herdr's own layouts; any other root is refused before anything is written. Show it with
  `herdr-app do layout.switch --name <active>-stats`;
- three keys are added to `keys.json`: `f7` toggles the docked block and
  `f8` the drawer (`layout.toggle`, in the clone's `layout:` section), and
  `f9` opens the popup (`mod.open`, in `global`, so it works in any layout; pressed
  again it closes). The popup is a larger dialog (`overlay` in `mod.json`) that draws each
  card roomy. Your bindings are kept; a key that is already taken (in its own section, in
  `global` or in `terminal`, and for the popup also in any `layout:` section, which would hide
  it there; by that exact spelling) is reported by the install and left unbound;
- the keys you have in the `layout:<active>` section are copied into `layout:<active>-stats`,
  because a section applies only while its layout shows. A key the clone's section already
  has stays as it is; nothing is replaced.

`keys.json` is rewritten as JSON in the file's own indentation whenever the install adds a key.
By herdr's rules an edited keys file is yours entirely, so shortcuts that herdr adds in later
releases then reach you only by hand.

Run again, it changes nothing. An existing clone is completed, never rebuilt, so edits you made
to it stay.

## Run and test

- `bun test` runs the tests (bun 1.4).
- `sh scripts/sync.sh` copies `src/` into `mods/herdr-session-stats/` and checks the mod with
  `herdr-app check`. `src/` is the source; the copy in the mod folder is generated and ignored
  by git (`main.js` and `mod.json` there are the mod's own).
- `bun scripts/install.js` installs the mod (see Install).

Everything in `src/` except `install-lib.js` runs in herdr's JS runtime, not in bun: no `bun:`
or `node:` import, no `Bun`, no `TextEncoder`, no `setInterval`, and only `exec` and
`readTextFile` for I/O, with read-only programs. `test/runtime-neutral.test.js` checks that.

## Known limits

- **A very long last line.** The figures about the end of a session (model, context, cache
  left, activity, latency) are read from the last 256 KiB of the file. If its last line is
  longer than that, the window holds no whole line, and those figures read `n/a`. The totals
  (tokens, cost, compactions and so on) are not affected.
- **A large session shows late the first time.** A session file over 256 KiB is read once in
  full, 4 MiB at a time, for its totals; the card waits for that pass, so the first card of a
  multi-megabyte session shows later than the rest. Then only what is appended is read.
- **Project-level omp config is not read.** Headroom uses the compaction settings in
  `~/.omp/agent/config.yml`; a setting made only in a project's own omp config is not seen.
- **Each open copy refreshes on its own.** The docked block, the drawer and the popup are
  copies of one mod, and each one that is open lists the files and reads their tails every 2
  seconds; a hidden copy may keep doing it. herdr shares a mod's module code between copies,
  but the mod does not share one refresh between them: the reads in flight would belong to the
  tasks of the copy that started them, and herdr leaves the promise of a cancelled task
  pending for ever, so the other copies could wait on it for ever when that copy closes (the
  popup closes often). Three open copies read the same files three times.
