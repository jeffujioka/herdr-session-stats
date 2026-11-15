// The install into a herdr home: the generated config around the mod. Runtime-neutral and free
// of any I/O of its own: `install` takes an `fs` (see below) and the name of the active layout,
// so the tests run it on a scratch home and the CLI (scripts/install.js) hands it node's files.
//
// What it does (spec D1, D10):
//  - mirrors the built mod folder (scripts/sync.sh's output) into `<home>/mods/<mod>`;
//  - clones the developer's active layout as `<active>-stats` and adds the dock and the drawer
//    to the clone; the active layout's own file is never written;
//  - merges the presentations' keys into `keys.json`: every binding that is there stays, and a
//    key that is taken is reported, never overwritten (the one exception is this mod's own
//    earlier drawer binding, which is upgraded to the drawer command).
// Run again, it finds everything in place and writes nothing.
//
// The presentations are an additive list (`PRESENTATIONS`): each one is `{ id, key }`, and the
// dock and the drawer also `{ blockId, addTo(layout) }`, the block they put into the clone and
// that their key shows or hides (the dock by `layout.toggle`, the drawer by the mod's own
// command). The overlay is a presentation without a block: its key is `mod.open`, bound in
// `global`, and nothing is added to the clone for it.
//
// `fs`: { exists(path), readText(path), writeText(path, text) (makes the folders),
//         listFiles(dir) (relative paths with '/', recursive, sorted), remove(path) }.

import { DRAWER_COMMAND } from './adapt.js';

export const MOD_NAME = 'herdr-session-stats';

// The docked block: a right-hand column at the top level of the clone.
const DOCK_PX = 320;
export const DOCK_BLOCK_ID = 'session-stats-dock';
export const DOCK_KEY = 'f7';

// The drawer: a floating block over the root, on the right edge; only `DRAWER_PEEK_PX` of it
// shows until it is hovered (herdr's `peek`).
const DRAWER_PEEK_PX = 72;
export const DRAWER_BLOCK_ID = 'session-stats-drawer';
export const DRAWER_KEY = 'f8';

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

// The docked block as a column at the right of the window: the last child of a root that is a
// row (the shape of herdr's own layouts). Any other root is refused, before anything is
// written, rather than rearranged on a guess. A block that is already in the layout is left as
// the developer has it.
function addDock(layout) {
  if (findNode(layout, DOCK_BLOCK_ID)) return layout;
  if (layout.type !== 'row') {
    throw new Error(`the layout has a ${layout.type} root; only a row root can take the docked column`);
  }
  const out = structuredClone(layout);
  out.children = [
    ...(out.children ?? []),
    { id: DOCK_BLOCK_ID, type: 'block', size: { px: DOCK_PX }, min: 200, max: 640, content: { mod: MOD_NAME } },
  ];
  return out;
}

// The drawer as a floating block of the root. A block that is already in the layout is left as
// the developer has it; the root's other floating blocks stay.
function addDrawer(layout) {
  if (findNode(layout, DRAWER_BLOCK_ID)) return layout;
  const out = structuredClone(layout);
  out.floating = [
    ...(out.floating ?? []),
    { id: DRAWER_BLOCK_ID, content: { mod: MOD_NAME }, edge: 'right', align: 'center', peek: DRAWER_PEEK_PX },
  ];
  return out;
}

// The overlay: a popup the mod opens over everything. It has no block in any layout and so is
// not added to the clone: its key is bound in `global` and runs `mod.open`, which opens the mod
// and, pressed again, closes it. Its size is the `overlay` of the mod's mod.json.
export const OVERLAY_KEY = 'f9';

// Each presentation is `{ id, key }`, and, when it is a block of a layout, `blockId` and
// `addTo(layout)` as well (the dock and the drawer); one without a `blockId` is the overlay's
// kind. A block's key runs `layout.toggle` on its block, unless the presentation has its own
// `action`; the drawer's is the mod's own command (D12: `layout.toggle` cannot find a floating
// block), and `replaces` is the earlier action of this mod on that key, upgraded on install.
export const PRESENTATIONS = [
  { id: 'dock', blockId: DOCK_BLOCK_ID, key: DOCK_KEY, addTo: addDock },
  {
    id: 'drawer',
    blockId: DRAWER_BLOCK_ID,
    key: DRAWER_KEY,
    addTo: addDrawer,
    action: `${MOD_NAME}.${DRAWER_COMMAND}`,
    replaces: `layout.toggle:${DRAWER_BLOCK_ID}`,
  },
  { id: 'overlay', key: OVERLAY_KEY },
];

// The keys of the presentations for the clone named `layoutName`. A block's key is bound in
// that layout's section only, so it does nothing in a layout that has no such block. The
// overlay's key runs `mod.open` in `global`, for any layout.
export function bindingsFor(layoutName) {
  return PRESENTATIONS.map(({ id, blockId, key, action, replaces }) =>
    blockId
      ? {
          presentation: id,
          section: `layout:${layoutName}`,
          key,
          action: action ?? `layout.toggle:${blockId}`,
          ...(replaces === undefined ? {} : { replaces }),
        }
      : { presentation: id, section: 'global', key, action: `mod.open:${MOD_NAME}` },
  );
}

// A `layout:<name>` section applies only while layouts/<name>.json shows, so the keys the
// developer has for the layout they use do nothing in its clone. Copies them into the clone's
// section, additively: a key the clone's section already has stays as it is, and nothing is
// replaced or removed. Returns `{ keys, copied: [{ key, action }] }`; the input is not changed.
export function copyLayoutKeys(keys, from, to) {
  const out = structuredClone(keys);
  const copied = [];
  for (const [key, action] of Object.entries(out[from] ?? {})) {
    if (out[to]?.[key] !== undefined) continue;
    (out[to] ??= {})[key] = action;
    copied.push({ key, action });
  }
  return { keys: out, copied };
}

// Merges `bindings` into `keys` without changing the input. A key goes in when no binding of
// the developer's is in its way: the same key in the binding's own section, in `global` (which
// it would shadow in the clone) or in `terminal` (which would shadow it) with another action is
// a conflict; so is a key that a `global` binding finds in any `layout:` section, which wins
// over `global` in its layout and would hide the binding there. A conflict is reported with
// what holds the key and not bound. A binding that is already in place is neither added nor a
// conflict, so a second run changes nothing. A binding with `replaces` takes over a key in its
// own section that still holds that exact action (the mod's own earlier binding), reported as
// added; any other action on the key is the developer's. Keys are compared by their exact
// spelling: `ctrl-shift-s` and `shift-ctrl-s` are not seen as the same key.
export function mergeKeys(keys, bindings) {
  const out = structuredClone(keys);
  const added = [];
  const conflicts = [];
  for (const binding of bindings) {
    const { presentation, section, key, action, replaces } = binding;
    if (out[section]?.[key] === action) continue;
    // this mod's own earlier binding on the key is not in the way: it is the one being replaced
    const upgrade = replaces !== undefined && out[section]?.[key] === replaces;
    const hiding = section === 'global' ? Object.keys(out).filter((s) => s.startsWith('layout:')) : [];
    const holder = [section, 'global', 'terminal', ...hiding].find(
      (s) => out[s]?.[key] !== undefined && !(upgrade && s === section),
    );
    if (holder) {
      conflicts.push({ presentation, key, section: holder, taken: out[holder][key] });
    } else {
      (out[section] ??= {})[key] = action;
      added.push(upgrade ? { ...binding, replaced: replaces } : binding);
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

// What the app writes into a mod's folder itself, and what is not the mod's: `jsconfig.json`
// and the `.d.ts` files at the top, hidden files and folders, `node_modules`.
const isAppFile = (rel) =>
  rel === 'jsconfig.json' ||
  (!rel.includes('/') && rel.endsWith('.d.ts')) ||
  rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules');

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
// `{ mod: { written, removed }, layout: { name, created, changed },
//    keys: { added, copied, conflicts } }`.
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
  const blocks = PRESENTATIONS.filter((p) => p.blockId);
  const isClone = blocks.some((p) => findNode(JSON.parse(activeText), p.blockId));
  const target = isClone ? active : `${active}-stats`;
  const targetPath = `${home}/layouts/${target}.json`;
  // A clone that exists is completed, never rebuilt from the active layout: it may have been
  // changed since, and those changes are the developer's.
  const created = !isClone && !fs.exists(targetPath);
  const baseText = created || isClone ? activeText : fs.readText(targetPath);
  const base = JSON.parse(baseText);
  const layout = blocks.reduce((l, p) => p.addTo(l), base);
  const layoutChanged = created || JSON.stringify(layout) !== JSON.stringify(base);

  // The keys of the layout in use come first, so the clone's section is whole when the
  // presentations' keys are checked against it.
  const copy = target === active ? { keys: JSON.parse(keysText), copied: [] } : copyLayoutKeys(JSON.parse(keysText), `layout:${active}`, `layout:${target}`);
  const merged = mergeKeys(copy.keys, bindingsFor(target));
  const keysChanged = copy.copied.length > 0 || merged.added.length > 0;

  const mod = mirrorMod(fs, modFrom, `${home}/mods/${MOD_NAME}`);
  if (layoutChanged) fs.writeText(targetPath, formatJson(layout, baseText));
  if (keysChanged) fs.writeText(keysPath, formatJson(merged.keys, keysText));
  return {
    mod,
    layout: { name: target, created, changed: layoutChanged },
    keys: { added: merged.added, copied: copy.copied, conflicts: merged.conflicts },
  };
}
