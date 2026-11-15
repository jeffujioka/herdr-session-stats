// The card list: which panes get a card and what each card holds (spec: one card per agent
// pane). Runtime-neutral, so it runs in herdr's JS runtime: the mod passes in herdr's async
// `exec(command, args, options)` (`{ code, stdout, stderr }`), `readTextFile` and the local
// home folder; tests pass in fakes of the same signatures. Everything is read-only and runs on
// the pane's machine through `on`, with a timeout, as the app's `exec` allows. Where a
// harness keeps its sessions is the harness's own business, behind the provider registry's
// `createSessions` hook (src/providers/index.js): this file knows no harness.
//
// The data comes in as plain values and goes out as plain values: `build(panes, now,
// onUpdate)` takes the panes (as `panes()` reports them, plus `machine`, the machine of the
// pane's space) and resolves to cards `{ id, folder, branch, origin, harness, harnessName,
// stats }`, where `stats` is what `readStats` returns. It never rejects: whatever cannot be
// read for a pane shows as n/a on that pane's card, never as an empty window (D4).
//
// Panes resolve independently. `onUpdate(cards)` is called with the current cards each time
// one pane finishes, so a slow machine delays only its own cards, and a pane still being
// resolved by an earlier call is not started again: its last card stays meanwhile.

import { readGit } from './git.js';
import { createSessions, readStats } from './providers/index.js';
import { collapseBySession } from './session-link.js';

// Longest any one program may run before the app's `exec` rejects it.
export const EXEC_TIMEOUT_MS = 10 * 1000;

// A folder's branch and origin are asked again after this long (the pane's own live branch
// is used first, and it is not cached).
export const GIT_TTL_MS = 30 * 1000;

// What the card calls a harness, by the `app` herdr reports; an unknown app is shown as it is.
const HARNESS_NAMES = { omp: 'omp', 'claude-code': 'Claude Code', opencode: 'opencode' };

export function harnessName(app) {
  return HARNESS_NAMES[app] ?? app;
}

// Stats of a card with no session to read: every figure n/a, the harness named.
const unlinked = (app) => ({ ...readStats('', null, 0), harness: app });

// The panes that get a card: terminals in which herdr detected an agent. A mod pane has no
// terminal, and a terminal with no agent reports no app.
export function agentPanes(panes) {
  return panes.filter((pane) => pane.terminal != null && pane.app);
}

// The panes of the shown space, in all of its tabs: `spaces` is herdr's `spaces()` (each with
// its `tabs` and `active`), and a pane names its tab. The cards are those of this space only.
export function panesOfActiveSpace(panes, spaces) {
  const tabs = new Set(spaces.filter((space) => space.active).flatMap((space) => space.tabs.map((tab) => tab.id)));
  return panes.filter((pane) => tabs.has(pane.tab));
}

const NO_GIT = { branch: null, origin: null };

export function createCardBuilder({ exec, readTextFile, home }) {
  // `exec` and `readTextFile` bound to a machine (null: this computer), `exec` with the timeout.
  const execs = new Map();
  function execOn(machine) {
    if (!execs.has(machine)) {
      const on = machine ? { on: machine } : {};
      execs.set(machine, (command, args, options) => exec(command, args, { timeout: EXEC_TIMEOUT_MS, ...options, ...on }));
    }
    return execs.get(machine);
  }
  const readTextOn = (machine) => (path) => readTextFile(path, machine ? { on: machine } : undefined);

  // The machine's home folder and operating system: they do not change, so they are read once
  // (and again if that failed). A remote home needs asking; this computer's is given.
  const places = new Map();
  function placeOn(machine) {
    if (!places.has(machine)) {
      const run = execOn(machine);
      const place = (async () => {
        const [uname, printenv] = await Promise.all([
          run('uname', ['-s']),
          machine ? run('printenv', ['HOME']) : Promise.resolve({ code: 0, stdout: home }),
        ]);
        const os = uname.code === 0 ? uname.stdout.trim() : null;
        const machineHome = printenv.code === 0 ? printenv.stdout.trim() : null;
        if (!os || !machineHome) throw new Error('machine place unknown');
        return { os, home: machineHome };
      })();
      place.catch(() => places.delete(machine));
      places.set(machine, place);
    }
    return places.get(machine);
  }

  // app -> that harness's session hook, or null: made once, on the first pane of the harness
  const sessions = new Map();
  function sessionsOf(app) {
    if (!sessions.has(app)) sessions.set(app, createSessions(app, { execOn, readTextOn }));
    return sessions.get(app);
  }

  // `machine\0folder` -> { at, value: Promise<{ branch, origin }> }
  const gits = new Map();
  function gitOf({ machine, cwd }, now) {
    const key = `${machine}\0${cwd}`;
    const hit = gits.get(key);
    if (hit && now - hit.at < GIT_TTL_MS) return hit.value;
    const value = readGit({ exec: execOn(machine) }, { cwd, on: machine }).catch(() => NO_GIT);
    gits.set(key, { at: now, value });
    return value;
  }

  // The pane's linked session file and the machine's home, or null: no hook, no folder, a
  // machine that cannot be reached, or a folder with no session.
  async function link(pane, now) {
    try {
      const hook = sessionsOf(pane.app);
      if (!hook || !pane.cwd) return null;
      const { os, home: machineHome } = await placeOn(pane.machine);
      const file = await hook.link({ machine: pane.machine, cwd: pane.cwd, home: machineHome, os, now });
      return file ? { file, home: machineHome } : null;
    } catch {
      return null;
    }
  }

  // `reads`: session key -> stats, shared by the panes of one build that link to one session.
  async function resolve(pane, now, reads) {
    const [git, linked] = await Promise.all([gitOf(pane, now), link(pane, now)]);
    // the machine is part of the key: two machines can hold the same path
    const sessionPath = linked ? `${pane.machine ?? ''}\0${linked.file.path}` : null;
    let stats;
    if (!linked) {
      stats = unlinked(pane.app);
    } else {
      if (!reads.has(sessionPath)) {
        reads.set(
          sessionPath,
          sessionsOf(pane.app)
            .read(linked.file, { machine: pane.machine, home: linked.home, now })
            .then((input) => readStats(pane.app, input, now))
            .catch(() => unlinked(pane.app)),
        );
      }
      stats = await reads.get(sessionPath);
    }
    return {
      sessionPath,
      card: {
        id: pane.pane,
        folder: pane.cwd ?? null,
        branch: pane.branch ?? git.branch,
        origin: git.origin,
        harness: pane.app,
        harnessName: harnessName(pane.app),
        stats,
      },
    };
  }

  // pane id -> its last resolved { sessionPath, card }; ids being resolved; ids of the latest
  // build in draw order
  const results = new Map();
  const running = new Set();
  let order = [];

  // The cards of the panes resolved so far, in draw order, a shared session shown once.
  function cards() {
    return collapseBySession(order.map((id) => results.get(id)).filter(Boolean)).map((entry) => entry.card);
  }

  function build(panes, now, onUpdate = () => {}) {
    const notify = () => {
      try {
        onUpdate(cards());
      } catch {
        // a listener's failure is not the pane's
      }
    };
    const agents = agentPanes(panes);
    order = agents.map((pane) => pane.pane);
    for (const id of [...results.keys()]) if (!order.includes(id)) results.delete(id);
    // panes that went away, and sessions they no longer share, leave the list at once
    notify();
    const reads = new Map();
    const started = agents
      .filter((pane) => !running.has(pane.pane))
      .map((pane) => {
        running.add(pane.pane);
        return resolve(pane, now, reads)
          .catch(() => ({ sessionPath: null, card: failedCard(pane) }))
          .then((entry) => {
            running.delete(pane.pane);
            if (!order.includes(pane.pane)) return;
            results.set(pane.pane, entry);
            notify();
          });
      });
    return Promise.all(started).then(cards);
  }

  return { build };
}

// A card for a pane whose resolution failed outright: its folder and n/a figures.
function failedCard(pane) {
  return {
    id: pane.pane,
    folder: pane.cwd ?? null,
    branch: pane.branch ?? null,
    origin: null,
    harness: pane.app,
    harnessName: harnessName(pane.app),
    stats: unlinked(pane.app),
  };
}
