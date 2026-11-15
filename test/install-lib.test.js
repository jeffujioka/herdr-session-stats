import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeLayoutFrom, bindingsFor, install, MOD_NAME, mergeKeys, PRESENTATIONS } from '../src/install-lib.js';
import { nodeFs } from '../scripts/install.js';

// A scratch repo (the mod folder as scripts/sync.sh leaves it) and a scratch herdr home. The
// developer's real ~/.config/herdr-app is never touched.
let dir;
let root;
let home;

// the mod's real mod.json
const MOD_JSON = readFileSync(new URL('../mods/herdr-session-stats/mod.json', import.meta.url), 'utf8');

const read = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));
const put = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

// every file of a folder, relative path -> text, for comparing two states of the home
function snapshot(folder, prefix = '') {
  const out = {};
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshot(path, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = read(path);
  }
  return out;
}

// the developer's layout: a row of a sidebar and the work area, in 2-space JSON like herdr's own
const ACTIVE = {
  id: 'root',
  cloned_from: { name: 'main', version: '0.1.13' },
  type: 'row',
  titlebar: 'none',
  children: [
    { id: 'sidebar', type: 'column', size: { px: 268 }, children: [{ id: 'spaces', type: 'block', content: { mod: 'spaces' } }] },
    { id: 'work', type: 'column', children: [{ id: 'main', type: 'block', content: { tab: 'active' } }] },
  ],
};
const ACTIVE_TEXT = `${JSON.stringify(ACTIVE, null, 2)}\n`;

const KEYS = {
  'layout:main': { 'cmd-shift-r': 'review-toggle.reviewer' },
  global: { 'cmd-q': 'app.quit', 'cmd-b': 'layout.toggle:sidebar' },
  terminal: { 'cmd-c': 'terminal.copy' },
};
const KEYS_TEXT = `${JSON.stringify(KEYS, null, 2)}\n`;

// every node id of a layout tree
function ids(node) {
  return [node.id, ...(node.children ?? []).flatMap(ids), ...(node.floating ?? []).flatMap(ids)].filter(Boolean);
}
function find(node, id) {
  if (node.id === id) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

function run(overrides = {}) {
  return install({ fs: nodeFs, root, home, active: 'main', ...overrides });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hss-install-'));
  root = join(dir, 'repo');
  home = join(dir, 'home');
  // the mod as sync leaves it: its own files, the copied modules, and what the app generates
  put(join(root, 'mods', MOD_NAME, 'main.js'), '// main\n');
  put(join(root, 'mods', MOD_NAME, 'mod.json'), MOD_JSON);
  put(join(root, 'mods', MOD_NAME, 'cards.js'), '// cards\n');
  put(join(root, 'mods', MOD_NAME, 'providers', 'index.js'), '// registry\n');
  put(join(root, 'mods', MOD_NAME, 'jsconfig.json'), '{ "repo": true }\n');
  put(join(root, 'mods', MOD_NAME, 'gpui-kit.d.ts'), '// repo copy\n');
  put(join(home, 'layouts', 'main.json'), ACTIVE_TEXT);
  put(join(home, 'keys.json'), KEYS_TEXT);
  put(join(home, 'mods', 'spaces', 'main.js'), '// the developer\'s other mod\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('install into herdr', () => {
  test('copies the mod', () => {
    // an earlier install's file that the mod no longer has, and what the app wrote into its copy
    put(join(home, 'mods', MOD_NAME, 'gone.js'), '// stale\n');
    put(join(home, 'mods', MOD_NAME, 'main.js'), '// old main\n');
    put(join(home, 'mods', MOD_NAME, 'jsconfig.json'), '{ "app": true }\n');
    put(join(home, 'mods', MOD_NAME, 'gpui-kit.d.ts'), '// app copy\n');
    put(join(home, 'mods', MOD_NAME, '.cache', 'state'), 'app\n');
    put(join(home, 'mods', MOD_NAME, 'node_modules', 'dep', 'index.js'), '// dep\n');
    put(join(root, 'mods', MOD_NAME, '.DS_Store'), 'finder\n');

    const report = run();

    const copy = join(home, 'mods', MOD_NAME);
    // hidden files and node_modules are not the mod's: not copied, not removed
    expect(read(join(copy, '.cache', 'state'))).toBe('app\n');
    expect(read(join(copy, 'node_modules', 'dep', 'index.js'))).toBe('// dep\n');
    expect(Object.keys(snapshot(copy))).not.toContain('.DS_Store');
    expect(read(join(copy, 'main.js'))).toBe('// main\n');
    expect(read(join(copy, 'mod.json'))).toBe(MOD_JSON);
    expect(read(join(copy, 'cards.js'))).toBe('// cards\n');
    expect(read(join(copy, 'providers', 'index.js'))).toBe('// registry\n');
    // the mod is a mirror: a file it no longer has goes, so the app never loads a stale module
    expect(Object.keys(snapshot(copy))).not.toContain('gone.js');
    // the app's own files are the app's: not copied over, not removed
    expect(read(join(copy, 'jsconfig.json'))).toBe('{ "app": true }\n');
    expect(read(join(copy, 'gpui-kit.d.ts'))).toBe('// app copy\n');
    // the developer's other mods are not touched
    expect(read(join(home, 'mods', 'spaces', 'main.js'))).toBe("// the developer's other mod\n");
    expect(report.mod.written.sort()).toEqual(['cards.js', 'main.js', 'mod.json', 'providers/index.js']);
    expect(report.mod.removed).toEqual(['gone.js']);
  });

  test('clones layout and leaves the original', () => {
    const report = run();

    // the active layout's own file is byte for byte unchanged
    expect(read(join(home, 'layouts', 'main.json'))).toBe(ACTIVE_TEXT);
    expect(report.layout).toMatchObject({ name: 'main-stats', created: true, changed: true });

    const clone = readJson(join(home, 'layouts', 'main-stats.json'));
    // everything the developer had is still there: the docked block is one more right-hand
    // column at the top level of the row, and the drawer floats over the root
    const { children, floating, ...rest } = clone;
    expect(children.slice(0, 2)).toEqual(ACTIVE.children);
    expect(children).toHaveLength(3);
    expect(floating).toHaveLength(1);
    expect(rest).toEqual({ ...ACTIVE, children: undefined });
    const dock = children[2];
    expect(dock.type).toBe('block');
    expect(dock.content).toEqual({ mod: MOD_NAME });
    expect(dock.hidden).toBeUndefined();
    expect(dock.size.px).toBeGreaterThan(0);
    // the file keeps the 2-space style of the layout it came from
    expect(read(join(home, 'layouts', 'main-stats.json'))).toBe(`${JSON.stringify(clone, null, 2)}\n`);
  });

  test('refuses a root that is not a row, and writes nothing', () => {
    const column = { id: 'root', type: 'column', children: [{ id: 'tabs', type: 'block', content: { mod: 'tabs' } }] };
    put(join(home, 'layouts', 'main.json'), `${JSON.stringify(column, null, 2)}\n`);
    const before = snapshot(home);

    expect(() => run()).toThrow(/column root/);

    expect(snapshot(home)).toEqual(before);
  });

  test('the mod docks nowhere by itself', () => {
    // herdr docks a new mod folder into the SHOWN layout from its mod.json `place`; that would
    // edit the developer's own layout, so the mod asks for no place and only the clone holds it
    expect(JSON.parse(MOD_JSON).place).toBe('none');
  });

  test('merges keys and reports conflicts', () => {
    // one of the developer's bindings is on the key the install wants; the layout they use has
    // two keys of its own, and the clone already has a binding of its own on one of them
    const taken = {
      ...KEYS,
      'layout:main': { ...KEYS['layout:main'], 'cmd-shift-g': 'review-toggle.gitlab' },
      'layout:main-stats': { 'cmd-shift-r': 'mine.own' },
      global: { ...KEYS.global, f7: 'tab.new' },
    };
    put(join(home, 'keys.json'), `${JSON.stringify(taken, null, 2)}\n`);

    const report = run();

    const keys = readJson(join(home, 'keys.json'));
    // every existing binding is kept as it was
    for (const [section, bindings] of Object.entries(taken)) expect(keys[section]).toMatchObject(bindings);
    expect(keys.global.f7).toBe('tab.new');
    // the key that was taken is reported, not overwritten, and not bound twice
    expect(report.keys.conflicts).toEqual([
      expect.objectContaining({ presentation: 'dock', key: 'f7', section: 'global', taken: 'tab.new' }),
    ]);
    expect(report.keys.added.map((b) => b.presentation)).toEqual(['drawer', 'overlay']);
    expect(JSON.stringify(keys)).not.toContain('session-stats-dock');
    // the keys of the layout the developer uses work in the clone too (a section applies only
    // while its layout shows): copied into the clone's section, where a key it already has stays
    expect(keys['layout:main']).toEqual(taken['layout:main']);
    expect(keys['layout:main-stats']).toEqual({
      'cmd-shift-r': 'mine.own',
      'cmd-shift-g': 'review-toggle.gitlab',
      f8: 'layout.toggle:session-stats-drawer',
    });
    expect(report.keys.copied).toEqual([{ key: 'cmd-shift-g', action: 'review-toggle.gitlab' }]);
  });

  test('a key taken in the layout section or the terminal section is a conflict too', () => {
    const layoutTaken = { ...KEYS, 'layout:main-stats': { f7: 'tab.new' } };
    put(join(home, 'keys.json'), `${JSON.stringify(layoutTaken, null, 2)}\n`);
    expect(run().keys.conflicts.map((c) => c.section)).toEqual(['layout:main-stats']);

    // the terminal section wins over the layout's, so the key would never reach the dock
    put(join(home, 'keys.json'), `${JSON.stringify({ ...KEYS, terminal: { ...KEYS.terminal, f7: 'send:x' } }, null, 2)}\n`);
    const report = run();
    expect(report.keys.conflicts.map((c) => [c.section, c.taken])).toEqual([['terminal', 'send:x']]);
  });

  test('second run is identical', () => {
    run();
    const first = snapshot(home);
    const keysFirst = read(join(home, 'keys.json'));

    const report = run();

    expect(snapshot(home)).toEqual(first);
    expect(read(join(home, 'keys.json'))).toBe(keysFirst);
    expect(report.mod).toEqual({ written: [], removed: [] });
    expect(report.layout).toMatchObject({ name: 'main-stats', created: false, changed: false });
    expect(report.keys).toEqual({ added: [], copied: [], conflicts: [] });
  });

  test('a run from the clone itself does not clone the clone', () => {
    run();
    const first = snapshot(home);
    // the developer switched to the clone, so that is now the active layout
    const report = run({ active: 'main-stats' });
    expect(snapshot(home)).toEqual(first);
    expect(report.layout.name).toBe('main-stats');
    expect(Object.keys(snapshot(join(home, 'layouts')))).toEqual(['main-stats.json', 'main.json']);
  });

  test('a clone the developer changed is completed, not rebuilt', () => {
    run();
    const path = join(home, 'layouts', 'main-stats.json');
    const clone = readJson(path);
    clone.children[2].size = { px: 400 };
    clone.children.push({ id: 'extra', type: 'block', content: { mod: 'files' } });
    writeFileSync(path, `${JSON.stringify(clone, null, 2)}\n`);
    const edited = read(path);

    run();

    expect(read(path)).toBe(edited);
  });

  test('refuses, and writes nothing, without keys.json or without the active layout', () => {
    rmSync(join(home, 'keys.json'));
    expect(() => run()).toThrow(/keys\.json/);
    put(join(home, 'keys.json'), KEYS_TEXT);
    expect(() => run({ active: 'nope' })).toThrow(/nope/);
    expect(() => run({ active: null })).toThrow(/active layout/);
    rmSync(join(root, 'mods', MOD_NAME, 'main.js'));
    expect(() => run()).toThrow(/sync/);
    expect(Object.keys(snapshot(home)).sort()).toEqual(['keys.json', 'layouts/main.json', 'mods/spaces/main.js']);
  });
});

describe('three presentations of the one mod', () => {
  test('dock key toggles docked block', () => {
    const report = run();

    const keys = readJson(join(home, 'keys.json'));
    const clone = readJson(join(home, 'layouts', 'main-stats.json'));
    // the key runs layout.toggle on the id of the block the clone holds, and only in that layout
    // (the developer's own keys for the layout are copied beside it)
    const action = keys['layout:main-stats'].f7;
    const key = 'f7';
    const [command, id] = action.split(':');
    expect(command).toBe('layout.toggle');
    expect(ids(clone).filter((x) => x === id)).toHaveLength(1);
    expect(find(clone, id).type).toBe('block');
    expect(find(clone, id).content).toEqual({ mod: MOD_NAME });
    expect(keys.global.f7).toBeUndefined();
    expect(report.keys.added).toContainEqual(expect.objectContaining({ presentation: 'dock', key, section: 'layout:main-stats', action }));
    expect(report.keys.conflicts).toEqual([]);
  });

  test('drawer is a floating peek block', () => {
    run();

    const clone = readJson(join(home, 'layouts', 'main-stats.json'));
    // a floating block over the root, on a side edge, with a peek width; it names the mod and
    // does not ask to start hidden
    expect(clone.floating).toHaveLength(1);
    const [drawer] = clone.floating;
    expect(drawer.content).toEqual({ mod: MOD_NAME });
    expect(drawer.edge).toBe('right');
    expect(drawer.peek).toBeGreaterThan(0);
    expect(drawer.hidden).toBeUndefined();
    // its id is its own: not the docked block's
    expect(ids(clone).filter((x) => x === drawer.id)).toHaveLength(1);
    expect(drawer.id).not.toBe('session-stats-dock');
    // the developer's layout is not the one that holds it
    expect(readJson(join(home, 'layouts', 'main.json')).floating).toBeUndefined();
  });

  test('drawer key toggles drawer block', () => {
    const report = run();

    const keys = readJson(join(home, 'keys.json'));
    const clone = readJson(join(home, 'layouts', 'main-stats.json'));
    const [drawer] = clone.floating;
    // the drawer's key runs layout.toggle on the drawer's block id, in the clone's section only
    const key = 'f8';
    expect(keys['layout:main-stats'][key]).toBe(`layout.toggle:${drawer.id}`);
    expect(keys.global[key]).toBeUndefined();
    expect(report.keys.added).toContainEqual(
      expect.objectContaining({ presentation: 'drawer', key, section: 'layout:main-stats', action: `layout.toggle:${drawer.id}` }),
    );
    expect(report.keys.conflicts).toEqual([]);
  });

  test('a drawer key that is taken is reported, the dock key still goes in', () => {
    put(join(home, 'keys.json'), `${JSON.stringify({ ...KEYS, global: { ...KEYS.global, f8: 'tab.new' } }, null, 2)}\n`);

    const report = run();

    expect(report.keys.conflicts).toEqual([expect.objectContaining({ presentation: 'drawer', key: 'f8', section: 'global', taken: 'tab.new' })]);
    expect(report.keys.added.map((b) => b.presentation)).toEqual(['dock', 'overlay']);
    expect(readJson(join(home, 'keys.json')).global.f8).toBe('tab.new');
  });

  test('overlay key is mod.open', () => {
    const report = run();

    const keys = readJson(join(home, 'keys.json'));
    const clone = readJson(join(home, 'layouts', 'main-stats.json'));
    const key = 'f9';
    // the overlay's key is `mod.open` for the mod: pressed once it opens, pressed again herdr
    // closes it. It is in `global`, so it works in any layout, with or without the clone
    expect(keys.global[key]).toBe(`mod.open:${MOD_NAME}`);
    expect(keys['layout:main-stats']?.[key]).toBeUndefined();
    expect(keys['layout:main']?.[key]).toBeUndefined();
    // and it needs no block: the overlay is not in the clone, which holds only the dock and the drawer
    expect(ids(clone).sort()).toEqual([...ids(ACTIVE), 'session-stats-dock', 'session-stats-drawer'].sort());
    expect(report.keys.added).toContainEqual(expect.objectContaining({ presentation: 'overlay', key, section: 'global', action: `mod.open:${MOD_NAME}` }));
    expect(report.keys.conflicts).toEqual([]);
    // the key is its own: not the dock's or the drawer's
    expect(new Set(PRESENTATIONS.map((p) => p.key)).size).toBe(PRESENTATIONS.length);
    // a layout that has none of the blocks still gets it
    const bare = mergeKeys({ global: {} }, bindingsFor('plain'));
    expect(bare.keys.global[key]).toBe(`mod.open:${MOD_NAME}`);
  });

  test('an overlay key that is taken, in global or in a layout section, is reported', () => {
    put(join(home, 'keys.json'), `${JSON.stringify({ ...KEYS, global: { ...KEYS.global, f9: 'tab.new' } }, null, 2)}\n`);
    let report = run();
    expect(report.keys.conflicts).toEqual([expect.objectContaining({ presentation: 'overlay', key: 'f9', section: 'global', taken: 'tab.new' })]);
    expect(report.keys.added.map((b) => b.presentation)).toEqual(['dock', 'drawer']);

    // a layout section wins over `global` in its layout, so a key it holds would hide the overlay there
    rmSync(join(home, 'layouts', 'main-stats.json'));
    put(join(home, 'keys.json'), `${JSON.stringify({ ...KEYS, 'layout:main': { ...KEYS['layout:main'], f9: 'mine.own' } }, null, 2)}\n`);
    report = run();
    expect(report.keys.conflicts.map((c) => [c.presentation, c.section, c.taken])).toEqual([['overlay', 'layout:main', 'mine.own']]);
    expect(readJson(join(home, 'keys.json')).global.f9).toBeUndefined();
  });
});

describe('the three keys', () => {
  test('adds dock, drawer and overlay keys', () => {
    const report = run();

    const keys = readJson(join(home, 'keys.json'));
    expect(keys['layout:main-stats'].f7).toBe('layout.toggle:session-stats-dock');
    expect(keys['layout:main-stats'].f8).toBe('layout.toggle:session-stats-drawer');
    expect(keys.global.f9).toBe(`mod.open:${MOD_NAME}`);
    expect(report.keys.added.map((b) => [b.presentation, b.key])).toEqual([
      ['dock', 'f7'],
      ['drawer', 'f8'],
      ['overlay', 'f9'],
    ]);
    expect(report.keys.conflicts).toEqual([]);
    // the developer's own bindings are kept
    expect(keys.global).toMatchObject(KEYS.global);
    expect(keys.terminal).toEqual(KEYS.terminal);
  });
});

describe('the active layout', () => {
  test('is what herdr-app status says is shown', () => {
    expect(activeLayoutFrom({ status: '{"layout":"main-alt-tab","floats":{}}', shared: '{"layout":"other"}' })).toBe('main-alt-tab');
  });

  test('is read from shared.json when the app does not answer', () => {
    expect(activeLayoutFrom({ status: null, shared: '{"layout":"main","x":1}' })).toBe('main');
    expect(activeLayoutFrom({ status: 'herdr is not running', shared: '{"layout":"main"}' })).toBe('main');
  });

  test('is null when neither says', () => {
    expect(activeLayoutFrom({ status: null, shared: null })).toBeNull();
    expect(activeLayoutFrom({ status: '{}', shared: '{"layout":""}' })).toBeNull();
    expect(activeLayoutFrom({ status: '{', shared: 'not json' })).toBeNull();
  });
});
