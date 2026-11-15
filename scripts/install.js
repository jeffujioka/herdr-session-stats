// Installs the mod into a herdr home: syncs the mod folder, copies it, clones the active layout
// as `<active>-stats` with the docked block and the drawer, and merges the three keys (dock,
// drawer, popup) into keys.json. All of the
// logic is in src/install-lib.js; this is the command line over it, and node's files for it.
//
// Usage: bun scripts/install.js [--home <dir>]
// The home is `--home`, else HERDR_APP_HOME, else ~/.config/herdr-app. The active layout is
// what `herdr-app status` says the window shows, else the `layout` in the home's shared.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { activeLayoutFrom, install } from '../src/install-lib.js';

// The `fs` of src/install-lib.js on node's files.
export const nodeFs = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
  writeText(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  listFiles(dir) {
    const out = [];
    const walk = (folder, prefix) => {
      for (const name of readdirSync(folder).sort()) {
        if (statSync(join(folder, name)).isDirectory()) walk(join(folder, name), `${prefix}${name}/`);
        else out.push(`${prefix}${name}`);
      }
    };
    walk(dir, '');
    return out;
  },
  remove: (path) => rmSync(path, { force: true }),
};

function parseArgs(argv) {
  const at = argv.indexOf('--home');
  if (at === -1) return {};
  if (!argv[at + 1]) throw new Error('--home needs a folder');
  return { home: argv[at + 1] };
}

function main() {
  const root = join(import.meta.dir, '..');
  const home = parseArgs(process.argv.slice(2)).home ?? process.env.HERDR_APP_HOME ?? join(homedir(), '.config', 'herdr-app');

  const sync = spawnSync('sh', ['scripts/sync.sh'], { cwd: root, stdio: 'inherit' });
  if (sync.status !== 0) throw new Error('scripts/sync.sh failed');

  // `status` asks the window of this home; with no window running for it the file answers
  const status = spawnSync('herdr-app', ['status'], { env: { ...process.env, HERDR_APP_HOME: home }, encoding: 'utf8' });
  const sharedPath = join(home, 'shared.json');
  const active = activeLayoutFrom({
    status: status.status === 0 ? status.stdout : null,
    shared: existsSync(sharedPath) ? readFileSync(sharedPath, 'utf8') : null,
  });

  const report = install({ fs: nodeFs, root, home, active });
  console.log(`home ${home}`);
  console.log(`mod: ${report.mod.written.length} file(s) written, ${report.mod.removed.length} removed`);
  console.log(`layout ${report.layout.name}: ${report.layout.created ? 'created' : report.layout.changed ? 'completed' : 'already in place'}`);
  if (report.keys.copied.length > 0) console.log(`${report.keys.copied.length} key(s) of the layout you use copied into layout:${report.layout.name}`);
  for (const k of report.keys.added) console.log(`key ${k.key} (${k.section}): ${k.action}`);
  for (const c of report.keys.conflicts) {
    console.log(`not bound: ${c.key} is taken in ${c.section} by ${JSON.stringify(c.taken)}; the ${c.presentation} has no key`);
  }
  console.log(`show it with: herdr-app do layout.switch --name ${report.layout.name}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`install: ${error.message}`);
    process.exit(1);
  }
}
