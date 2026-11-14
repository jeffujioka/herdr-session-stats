// The card list: which panes get a card and what each card holds (spec: one card per agent
// pane). Runtime-neutral, so it runs in herdr's JS runtime: the mod passes in herdr's async
// `exec(command, args, options)` (`{ code, stdout, stderr }`) and the local home folder, tests
// pass in a fake of the same signature. Every program run here is read-only (`uname`, `printenv`,
// `find` with `stat`, `tail`, `grep`, `git`, `sqlite3 -readonly`, `omp config list`) and is run
// on the pane's machine through `on`, with a timeout, as the app's `exec` allows.
//
// The data comes in as plain values and goes out as plain values: `build(panes, now)` takes
// the panes (as `panes()` reports them, plus `machine`, the machine of the pane's space) and
// resolves to cards `{ id, folder, branch, origin, harness, harnessName, stats }`, where
// `stats` is what `readStats` returns. It never rejects: whatever cannot be read for a pane
// shows as n/a on that pane's card, never as an empty window (D4).

import { readGit } from './git.js';
import { formatContext, formatTokens } from './format.js';
import { NA, readStats } from './providers/index.js';
import { createSessionReader } from './refresh.js';
import { collapseBySession, linkSession } from './session-link.js';

// Longest any one program may run before the app's `exec` rejects it.
export const EXEC_TIMEOUT_MS = 10 * 1000;

// The model catalogue and the compaction settings of a harness change rarely; they are read
// again after this long rather than at every refresh.
export const SLOW_SOURCE_TTL_MS = 60 * 1000;

// A folder's branch and origin are asked again after this long (the pane's own live branch
// is used first, and it is not cached).
export const GIT_TTL_MS = 30 * 1000;

// What the card calls a harness, by the `app` herdr reports; an unknown app is shown as it is.
const HARNESS_NAMES = { omp: 'omp', 'claude-code': 'Claude Code', opencode: 'opencode' };

export function harnessName(app) {
  return HARNESS_NAMES[app] ?? app;
}

// The panes that get a card: terminals in which herdr detected an agent. A mod pane has no
// terminal, and a terminal with no agent reports no app.
export function agentPanes(panes) {
  return panes.filter((pane) => pane.terminal != null && pane.app);
}

// Name of omp's session folder for a working folder (docs/omp-session-format.md): under the
// home folder it is the path below home with `/` as `-` and a `-` in front (home itself is
// `-`); elsewhere it is the path with `/` as `-` between two dashes on each end. omp's own
// rule has a third case for folders under the system temp folder, which the mod leaves out:
// such a folder has no linked session, so its card reads n/a.
export function sessionDirSlug(cwd, home) {
  const flat = (path) => path.replace(/[/\\:]/g, '-');
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  if (home && (path === home || path.startsWith(`${home}/`))) return `-${flat(path.slice(home.length + 1))}`;
  return `--${flat(path.replace(/^[/\\]/, ''))}--`;
}

// Lines of `stat` as `<mtime seconds> <size> <path>`; anything else is skipped.
export function parseSessionFiles(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\d+) (\d+) (.+)$/.exec(line);
    if (match) files.push({ path: match[3], mtimeMs: Number(match[1]) * 1000, size: Number(match[2]) });
  }
  return files;
}

// `stat` prints its format differently on BSD (macOS) and GNU (Linux); `uname -s` says which.
const STAT_FORMATS = {
  Darwin: ['-f', '%m %z %N'],
  Linux: ['-c', '%Y %s %n'],
};

// Latest provider named by an assistant message of an omp session tail, or null. The catalogue
// holds one row per provider, so the model's window is looked up in its provider's.
function lastAssistantProvider(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"role":"assistant"')) continue;
    try {
      const provider = JSON.parse(lines[i]).message?.provider;
      if (typeof provider === 'string') return provider;
    } catch {
      // a line cut at the start of the tail window
    }
  }
  return null;
}

// The `compaction` block of `omp config list`: `  compaction.<key> = <JSON value> (<type>)`
// per line, `(not set)` for a key without a value. Null when no compaction line can be read, or
// a setting the provider reads is not JSON: the trigger is then unknown and the headroom n/a.
const COMPACTION_KEYS = ['enabled', 'thresholdTokens', 'thresholdPercent', 'reserveTokens', 'modelThresholds', 'modelThresholdsEnabled'];

function parseCompactionConfig(stdout) {
  const settings = {};
  let seen = false;
  for (const line of stdout.split('\n')) {
    const match = /^\s*compaction\.(\w+) = (.*) \(\w+\)\s*$/.exec(line);
    if (!match) continue;
    seen = true;
    const [, key, value] = match;
    if (value === '(not set)') continue;
    try {
      settings[key] = JSON.parse(value);
    } catch {
      if (COMPACTION_KEYS.includes(key)) return null;
    }
  }
  return seen ? settings : null;
}

// Models of one provider from the newest catalogue row (D8 (b)): `[{ id, contextWindow }]`.
// `provider` comes from a session file, so it is only used when it is a plain name.
function catalogueQuery(provider) {
  return (
    "SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.contextWindow') AS contextWindow " +
    'FROM model_cache, json_each(model_cache.models) AS j ' +
    'WHERE model_cache.provider_id = (SELECT provider_id FROM model_cache ' +
    `WHERE substr(provider_id, 1, ${provider.length + 1}) = '${provider}:' ORDER BY updated_at DESC LIMIT 1)`
  );
}

export function createCardBuilder({ exec, home }) {
  // `exec` bound to a machine (null: this computer), with the timeout.
  const execs = new Map();
  function execOn(machine) {
    if (!execs.has(machine)) {
      const on = machine ? { on: machine } : {};
      execs.set(machine, (command, args, options) => exec(command, args, { timeout: EXEC_TIMEOUT_MS, ...options, ...on }));
    }
    return execs.get(machine);
  }

  // machine -> the reader that keeps that machine's per-file compaction counts
  const readers = new Map();
  function readerOn(machine) {
    if (!readers.has(machine)) readers.set(machine, createSessionReader({ exec: execOn(machine) }));
    return readers.get(machine);
  }

  // key -> { at, value: Promise }: a value reused for `ttl` ms, also by panes asking at once
  const cache = new Map();
  function cached(key, ttl, now, load) {
    const hit = cache.get(key);
    if (hit && now - hit.at < ttl) return hit.value;
    const value = load();
    cache.set(key, { at: now, value });
    return value;
  }

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

  // omp's catalogue and compaction settings are read from omp's own files on the pane's machine;
  // a missing sqlite3, omp or database reads as null (the figures read n/a).
  async function readCatalogue(machine, machineHome, provider, now) {
    if (!/^[\w.-]+$/.test(provider ?? '')) return null;
    return cached(`catalogue ${machine}\0${provider}`, SLOW_SOURCE_TTL_MS, now, async () => {
      try {
        const db = `${machineHome}/.omp/agent/models.db`;
        const { code, stdout } = await execOn(machine)('sqlite3', ['-readonly', '-json', db, catalogueQuery(provider)]);
        if (code !== 0 || stdout.trim() === '') return null;
        const rows = JSON.parse(stdout);
        return Array.isArray(rows) ? rows : null;
      } catch {
        return null;
      }
    });
  }

  function readCompaction(machine, now) {
    return cached(`compaction ${machine}`, SLOW_SOURCE_TTL_MS, now, async () => {
      try {
        const { code, stdout } = await execOn(machine)('omp', ['config', 'list']);
        return code === 0 ? parseCompactionConfig(stdout) : null;
      } catch {
        return null;
      }
    });
  }

  // Harnesses with a provider and a place the mod can find their sessions: `folder` is the
  // session folder of a working folder; `input` reads a linked session file for `readStats`.
  const sessionSources = {
    omp: {
      folder: (cwd, machineHome) => `${machineHome}/.omp/agent/sessions/${sessionDirSlug(cwd, machineHome)}`,
      async input(machine, machineHome, file, now) {
        const { text, sources } = await readerOn(machine).read(file);
        const provider = lastAssistantProvider(text);
        const [catalogue, compaction] = await Promise.all([
          readCatalogue(machine, machineHome, provider, now),
          readCompaction(machine, now),
        ]);
        return { text, sources: { ...sources, catalogue, compaction } };
      },
    },
  };

  // The newest session file of the pane's folder that the pane links to, as
  // `{ path, mtimeMs, size, machineHome }`, or null.
  async function linkedFile(pane, now) {
    const source = sessionSources[pane.app];
    if (!source || !pane.cwd) return null;
    const { os, home: machineHome } = await placeOn(pane.machine);
    const format = STAT_FORMATS[os];
    if (!format) return null;
    const dir = source.folder(pane.cwd, machineHome);
    const listed = await execOn(pane.machine)('find', [dir, '-maxdepth', '1', '-name', '*.jsonl', '-exec', 'stat', ...format, '{}', '+']);
    if (listed.code !== 0) return null;
    const files = parseSessionFiles(listed.stdout);
    const path = linkSession(files, now);
    const file = files.find((candidate) => candidate.path === path);
    return file ? { ...file, machineHome } : null;
  }

  function gitOf(pane, now) {
    return cached(`git ${pane.machine}\0${pane.cwd}`, GIT_TTL_MS, now, () =>
      readGit({ exec: execOn(pane.machine) }, { cwd: pane.cwd, on: pane.machine }).catch(() => ({ branch: null, origin: null })),
    );
  }

  const unlinked = (app) => ({ ...readStats('', null, 0), harness: app });

  async function resolve(pane, now) {
    const [git, file] = await Promise.all([gitOf(pane, now), linkedFile(pane, now).catch(() => null)]);
    // the machine is part of the key: two machines can hold the same path
    return { pane, git, file, sessionPath: file ? `${pane.machine ?? ''}\0${file.path}` : null };
  }

  async function statsOf({ pane, file }, now) {
    if (!file) return unlinked(pane.app);
    try {
      const input = await sessionSources[pane.app].input(pane.machine, file.machineHome, file, now);
      return readStats(pane.app, input, now);
    } catch {
      return unlinked(pane.app);
    }
  }

  async function build(panes, now) {
    const resolved = await Promise.all(
      agentPanes(panes).map((pane) => resolve(pane, now).catch(() => ({ pane, git: { branch: null, origin: null }, file: null, sessionPath: null }))),
    );
    return Promise.all(
      collapseBySession(resolved).map(async (entry) => {
        const { pane, git } = entry;
        return {
          id: pane.pane,
          folder: pane.cwd ?? null,
          branch: pane.branch ?? git.branch,
          origin: git.origin,
          harness: pane.app,
          harnessName: harnessName(pane.app),
          stats: await statsOf(entry, now),
        };
      }),
    );
  }

  return { build };
}

// Text of a duration: "450ms", "12s", "1m 30s", "1h 05m". Takes a number or 'n/a'.
export function formatDuration(ms) {
  if (ms === NA) return NA;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

const via = (value, format) => (value === NA ? NA : format(value));

// What the card draws, as text: its harness, its place lines (the folder, and the branch and
// origin when it has them) and its `[label, value]` rows. A figure that cannot be read is 'n/a'.
export function describeCard({ folder, branch, origin, harnessName: name, stats }) {
  const hasCounts = stats.cacheHits !== NA && stats.cacheMisses !== NA;
  const rate = via(stats.cacheHitRate, (r) => `${Math.round(r * 100)}%`);
  const burn =
    stats.burnCostPerHour === NA && stats.burnTokensPerMin === NA
      ? NA
      : `${via(stats.burnCostPerHour, (c) => `$${c.toFixed(2)}/h`)}, ${via(stats.burnTokensPerMin, (t) => `${formatTokens(Math.round(t))} tok/min`)}`;
  return {
    title: name,
    place: [folder, branch, origin].filter(Boolean),
    rows: [
      ['Model', stats.model],
      ['Duration', formatDuration(stats.durationMs)],
      ['Tokens', via(stats.totalTokens, formatTokens)],
      ['Context', formatContext(stats)],
      ['Headroom', via(stats.headroomTokens, formatTokens)],
      ['Compactions', via(stats.autocompactions, String)],
      ['Cache hit', hasCounts ? `${rate} (${stats.cacheHits} hit, ${stats.cacheMisses} miss)` : rate],
      ['Cache left', via(stats.cacheLeftMs, (ms) => (ms === 0 ? 'cold' : formatDuration(ms)))],
      ['Cost', via(stats.costUsd, (c) => `$${c.toFixed(2)}`)],
      ['Burn', burn],
      ['Activity', via(stats.sinceActivityMs, (ms) => `${formatDuration(ms)} ago`)],
      ['Latency', formatDuration(stats.latencyMs)],
      ['Thinking', stats.thinkingLevel],
      ['Premium', via(stats.premiumRequests, String)],
    ],
  };
}
