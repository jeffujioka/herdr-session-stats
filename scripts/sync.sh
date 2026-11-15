#!/bin/sh
# Copy src/ into the mod folder, so the mod is self-contained (the app loads a mod folder and
# nothing outside it), then check the mod as the app loads it. The copy is generated and
# ignored by git; main.js and mod.json are the mod's own files and stay. src/readers-bun.js
# is for the tests only and src/install-lib.js for the install only (neither is the mod's, and
# a copy in the folder would trigger a hot reload for nothing); the app writes jsconfig.json
# and the .d.ts files into the folder. An excluded file is also kept by --delete, so a stale
# copy from before an exclude was added has to be removed by hand once.
set -eu
cd "$(dirname "$0")/.."
mod=mods/herdr-session-stats
rsync -a --delete --exclude main.js --exclude mod.json --exclude readers-bun.js --exclude install-lib.js --exclude jsconfig.json --exclude '*.d.ts' src/ "$mod/"
herdr-app check "$mod"
