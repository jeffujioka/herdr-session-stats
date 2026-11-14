// The install into a herdr home: the generated config around the mod. Runtime-neutral and free
// of any I/O of its own: `install` takes an `fs` (see below) and the name of the active layout,
// so the tests run it on a scratch home and the CLI (scripts/install.js) hands it node's files.
//
// What it does (spec D1, D10):
//  - mirrors the built mod folder (scripts/sync.sh's output) into `<home>/mods/<mod>`;
//  - clones the developer's active layout as `<active>-stats` and adds the presentations to the
//    clone; the active layout's own file is never written;
//  - merges the presentations' keys into `keys.json`: every binding that is there stays, and a
//    key that is taken is reported, never overwritten.
// Run again, it finds everything in place and writes nothing.
//
// The presentations are an additive list (`PRESENTATIONS`): each one is `{ id, blockId, key,
// addTo(layout) }`, the block it puts into the clone and the key that toggles it. The drawer and
// the overlay are one more entry each, not a change to the install.
//
// `fs`: { exists(path), readText(path), writeText(path, text) (makes the folders),
//         listFiles(dir) (relative paths with '/', recursive, sorted), remove(path) }.

export const MOD_NAME = 'herdr-session-stats';

// The docked block: a right-hand column at the top level of the clone.
const DOCK_PX = 320;
export const DOCK_BLOCK_ID = 'session-stats-dock';
export const DOCK_KEY = 'ctrl-shift-s';

// Properties that describe the root node as a body (its way of arranging children and what
// paints it); a root that is not a row moves them to the body it is wrapped as. What is left
// (`titlebar`, `traffic_lights`, `terminal_menu`, `toast`, `preview`, `cloned_from`, the look
// that cascades) stays on the root of the window.
const BODY_KEYS = [
  'type', 'children', 'gap', 'divider', 'resizable', 'padding', 'background', 'border', 'radius',
  'shadow', 'focus', 'content', 'pane', 'active', 'header', 'floating', 'window_drag', 'min', 'max',
];

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

// The docked block as a column at the right of the window. A root that is a row gets it as its
// last child; any other root is wrapped as the body of a new row, so the block is still beside
// the whole window. A block that is already in the layout is left as the developer has it.
function addDock(layout) {
  if (findNode(layout, DOCK_BLOCK_ID)) return layout;
  const out = structuredClone(layout);
  const dock = {
    id: DOCK_BLOCK_ID,
    type: 'block',
    size: { px: DOCK_PX },
    min: 200,
    max: 640,
    content: { mod: MOD_NAME },
  };
  if (out.type === 'row') {
    out.children = [...(out.children ?? []), dock];
    return out;
  }
  const body = { id: `${out.id ?? 'root'}-body` };
  const root = {};
  for (const [key, value] of Object.entries(out)) (BODY_KEYS.includes(key) ? body : root)[key] = value;
  return { ...root, type: 'row', children: [body, dock] };
}

export const PRESENTATIONS = [
  { id: 'dock', blockId: DOCK_BLOCK_ID, key: DOCK_KEY, addTo: addDock },
];

// The keys of the presentations in the clone named `layoutName`: the key runs `layout.toggle`
// on the presentation's block, in that layout's section only, so it does nothing in a layout
// that has no such block.
export function bindingsFor(layoutName) {
  return PRESENTATIONS.map((p) => ({
    presentation: p.id,
    section: `layout:${layoutName}`,
    key: p.key,
    action: `layout.toggle:${p.blockId}`,
  }));
}

// Merges `bindings` into `keys` without changing the input. A key goes in when no binding of
// the developer's is in its way: the same key in the binding's own section, in `global` (which
// it would shadow in the clone) or in `terminal` (which would shadow it) with another action is
// a conflict; it is reported with what holds the key and not bound. A binding that is already in
// place is neither added nor a conflict, so a second run changes nothing.
export function mergeKeys(keys, bindings) {
  const out = structuredClone(keys);
  const added = [];
  const conflicts = [];
  for (const binding of bindings) {
    const { presentation, section, key, action } = binding;
    if (out[section]?.[key] === action) continue;
    const holder = [section, 'global', 'terminal'].find((s) => out[s]?.[key] !== undefined);
    if (holder) {
      conflicts.push({ presentation, key, section: holder, taken: out[holder][key] });
    } else {
      (out[section] ??= {})[key] = action;
      added.push(binding);
    }
  }
  return { keys: out, added, conflicts };
}

// Serializes `value` in the indentation style of `original` (the file's previous text).
export function formatJson(value, original) {
  const body = original.trim();
  if (!body.includes('\n')) return `${JSON.stringify(value)}\n`;
  const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '  ';
  return `${JSON.stringify(value, null, indent)}\n`;
}

// The name of the layout the window shows: `herdr-app status`' `layout` when the app answers,
// else the `layout` of the home's shared.json (the app keeps it there), else null. Both
// arguments are the texts read (or null).
export function activeLayoutFrom({ status, shared }) {
  for (const text of [status, shared]) {
    try {
      const name = JSON.parse(text)?.layout;
      if (typeof name === 'string' && name !== '') return name;
    } catch {
      // not JSON: the app is not running, or the file is not there
    }
  }
  return null;
}

// The app writes these into a mod's folder itself; they are not the mod's.
const isAppFile = (rel) => rel === 'jsconfig.json' || (!rel.includes('/') && rel.endsWith('.d.ts'));

// Makes `<home>/mods/<mod>` a mirror of the built mod folder, leaving the app's own files.
// Writes only what differs, so the app's hot reload fires for a change and for nothing else.
function mirrorMod(fs, from, to) {
  const wanted = fs.listFiles(from).filter((rel) => !isAppFile(rel));
  const written = [];
  for (const rel of wanted) {
    const text = fs.readText(`${from}/${rel}`);
    if (fs.exists(`${to}/${rel}`) && fs.readText(`${to}/${rel}`) === text) continue;
    fs.writeText(`${to}/${rel}`, text);
    written.push(rel);
  }
  const removed = fs.exists(to) ? fs.listFiles(to).filter((rel) => !isAppFile(rel) && !wanted.includes(rel)) : [];
  for (const rel of removed) fs.remove(`${to}/${rel}`);
  return { written, removed };
}

// Installs into `home` the mod built in `root` and the config around it. `active` is the name
// of the developer's active layout (see `activeLayoutFrom`). Everything is read and checked
// before anything is written, so a refusal leaves the home as it was. Returns
// `{ mod: { written, removed }, layout: { name, created, changed }, keys: { added, conflicts } }`.
export function install({ fs, root, home, active }) {
  const modFrom = `${root}/mods/${MOD_NAME}`;
  if (!fs.exists(`${modFrom}/main.js`)) throw new Error(`the mod is not built: run scripts/sync.sh first (no ${modFrom}/main.js)`);
  const keysPath = `${home}/keys.json`;
  // Without a keys.json herdr uses its built-in keys; one holding only ours would drop them all.
  if (!fs.exists(keysPath)) throw new Error(`no ${keysPath}: open herdr once so it writes one, then run the install again`);
  if (!active) throw new Error('cannot tell the active layout: start herdr, or name it in shared.json');
  const activePath = `${home}/layouts/${active}.json`;
  if (!fs.exists(activePath)) throw new Error(`the active layout ${active} has no file ${activePath}`);

  const activeText = fs.readText(activePath);
  const keysText = fs.readText(keysPath);

  // The clone is `<active>-stats`. When the developer has switched to the clone, it is the
  // active layout and holds the presentations already: it is the one to complete.
  const isClone = PRESENTATIONS.some((p) => findNode(JSON.parse(activeText), p.blockId));
  const target = isClone ? active : `${active}-stats`;
  const targetPath = `${home}/layouts/${target}.json`;
  // A clone that exists is completed, never rebuilt from the active layout: it may have been
  // changed since, and those changes are the developer's.
  const created = !isClone && !fs.exists(targetPath);
  const baseText = created || isClone ? activeText : fs.readText(targetPath);
  const base = JSON.parse(baseText);
  const layout = PRESENTATIONS.reduce((l, p) => p.addTo(l), base);
  const layoutChanged = created || JSON.stringify(layout) !== JSON.stringify(base);

  const merged = mergeKeys(JSON.parse(keysText), bindingsFor(target));

  const mod = mirrorMod(fs, modFrom, `${home}/mods/${MOD_NAME}`);
  if (layoutChanged) fs.writeText(targetPath, formatJson(layout, baseText));
  if (merged.added.length > 0) fs.writeText(keysPath, formatJson(merged.keys, keysText));
  return {
    mod,
    layout: { name: target, created, changed: layoutChanged },
    keys: { added: merged.added, conflicts: merged.conflicts },
  };
}
