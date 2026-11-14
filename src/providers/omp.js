// omp provider: reads the jsonl text of an omp session (docs/omp-session-format.md) and
// returns the stats of src/providers/index.js that it can read. A figure it cannot read is
// left out, which the registry turns into 'n/a'; nothing here estimates one.
//
// Pure apart from two read-only sources the context figures need: omp's model catalogue and
// omp's config. `createOmpProvider` takes them as functions, so tests hand in values; the
// default provider reads the real files (see "Default sources" at the end). `input` is the
// jsonl text.
//
// Structure: `parseSession` turns the text into one `session` value; each entry of `FIGURES`
// is a function `(session, now) => partial stats` (`now` is epoch ms; only a figure that
// measures from the present reads it). A later figure is one more function in the list, so
// adding a figure never rewrites an earlier one. The figures that need a source are built by
// `contextFigure(sources)` and added to the list in `createOmpProvider`.

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Lines that are not whole JSON (a tail window can start mid-line) are skipped.
function parseEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch {
      // partial or damaged line: carries no figure
    }
  }
  return entries;
}

function parseSession(text) {
  const entries = parseEntries(text);
  const messages = entries.filter((e) => e.type === 'message' && e.message);
  const assistants = messages.filter((e) => e.message.role === 'assistant').map((e) => e.message);
  // The `session` entry is the second line of a file, so a text that holds it starts at the
  // top of the file; a tail window does not.
  const fromStart = entries.some((e) => e.type === 'session');
  const compactions = entries.filter((e) => e.type === 'compaction').length;
  return { messages, assistants, fromStart, compactions };
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Sum of `pick(assistant message)` over the messages that have it; undefined when none has.
function sumAssistants(session, pick) {
  const values = session.assistants.map(pick).filter(isNumber);
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

function model({ assistants }) {
  const latest = assistants.at(-1)?.model;
  return typeof latest === 'string' && latest ? { model: latest } : {};
}

// First to last message, by the entries' own ISO timestamps (present on every message entry).
function duration({ messages }) {
  const first = Date.parse(messages[0]?.timestamp);
  const last = Date.parse(messages.at(-1)?.timestamp);
  return isNumber(first) && isNumber(last) ? { durationMs: last - first } : {};
}

function tokens(session) {
  const totalTokens = sumAssistants(session, (m) => m.usage?.totalTokens);
  return totalTokens === undefined ? {} : { totalTokens };
}

// Cost the harness logged (D5); no price table.
function cost(session) {
  const costUsd = sumAssistants(session, (m) => m.usage?.cost?.total);
  return costUsd === undefined ? {} : { costUsd };
}

// Hit rate is over the session's token counts (D6); it needs all three counts to be logged
// and a non-zero total.
function cacheRate(session) {
  const input = sumAssistants(session, (m) => m.usage?.input);
  const cacheRead = sumAssistants(session, (m) => m.usage?.cacheRead);
  const cacheWrite = sumAssistants(session, (m) => m.usage?.cacheWrite);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return {};
  const total = input + cacheRead + cacheWrite;
  return total > 0 ? { cacheHitRate: cacheRead / total } : {};
}

// A turn is a hit when its cacheRead is above 0 and a miss when it is 0 (D6); a turn that
// logged no cacheRead is neither.
function cacheTurns({ assistants }) {
  const reads = assistants.map((m) => m.usage?.cacheRead).filter(isNumber);
  if (!reads.length) return {};
  const cacheHits = reads.filter((read) => read > 0).length;
  return { cacheHits, cacheMisses: reads.length - cacheHits };
}

// The key of `usage.cttl` names the cache lifetime class; its value is a token count
// (docs/omp-session-format.md, D8 (d)).
const CACHE_LIFETIME_MS = { ephemeral5m: 5 * 60 * 1000 };

// Time left on the prompt cache after the last assistant turn, counted from the turn's
// completion; 0 once it has expired. Only that turn's own cttl counts.
function cacheExpiry({ assistants }, now) {
  const last = assistants.at(-1);
  const lifetimes = Object.keys(last?.usage?.cttl ?? {})
    .map((key) => CACHE_LIFETIME_MS[key])
    .filter(isNumber);
  const completedAt = isNumber(last?.completedAt)
    ? last.completedAt
    : last?.timestamp + last?.duration;
  if (!lifetimes.length || !isNumber(completedAt) || !isNumber(now)) return {};
  return { cacheLeftMs: Math.max(0, completedAt + Math.max(...lifetimes) - now) };
}

const FIGURES = [model, duration, tokens, cost, cacheRate, cacheTurns, cacheExpiry];

// Compactions recorded in the session (docs/omp-session-format.md, D8 (a)): omp does not
// mark automatic ones, so this counts all `compaction` entries. Counting needs the whole
// file; a tail window can hold only some of them, so it reads n/a, never 0.
function autocompactions({ fromStart, compactions }) {
  return fromStart ? { autocompactions: compactions } : {};
}

// Window of the latest assistant message's model, from omp's model catalogue (D8 (b)).
function contextWindow(modelCatalogue, { provider, model } = {}) {
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  const window = modelCatalogue(provider)?.find((entry) => entry?.id === model)?.contextWindow;
  return isNumber(window) && window > 0 ? window : undefined;
}

// The default reserve and its 15% floor are omp's own rule: omp://compaction.md "Settings and
// defaults" (`compaction.reserveTokens`) and omp://settings.md (`compaction.thresholdTokens`,
// `thresholdPercent`, `modelThresholds`); the code of omp 18.20.2 agrees (reserve is
// `max(floor(window * 0.15), reserveTokens ?? 16384)`). On a 1M window this is 850,000.
const DEFAULT_RESERVE = 16384;

// Trigger of the reserve-based default; undefined where the doc leaves the result to omp's
// small-window fallback (a window whose 15% is under the default reserve, or a reserve that
// swallows the window), which the mod does not copy.
function reserveTrigger(window, configured) {
  const floor = Math.floor(window * 0.15);
  const explicit = isNumber(configured);
  if (!explicit && floor < DEFAULT_RESERVE) return undefined;
  const reserve = Math.max(floor, explicit ? configured : DEFAULT_RESERVE);
  return reserve < window ? window - reserve : undefined;
}

// A `modelThresholds` key is `provider/model-id` or a `*`-terminated prefix of it.
function hasModelThreshold(modelThresholds, key) {
  if (!modelThresholds || typeof modelThresholds !== 'object') return false;
  return Object.keys(modelThresholds).some((pattern) =>
    pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key,
  );
}

// Tokens at which omp autocompacts (D8 (c)), from the `compaction` block of its config;
// undefined when it cannot be known: config unreadable, autocompaction off, or a per-model
// entry for this model, whose scaling the mod does not evaluate. Project-level config files
// are not read, so a setting made only there is not seen.
function compactionTrigger(window, key, settings) {
  if (!settings || settings.enabled === false) return undefined;
  if (settings.modelThresholdsEnabled !== false && hasModelThreshold(settings.modelThresholds, key)) {
    return undefined;
  }
  const { thresholdTokens, thresholdPercent, reserveTokens } = settings;
  // a fixed trigger at or past the window compacts like the default
  if (isNumber(thresholdTokens) && thresholdTokens > 0 && thresholdTokens < window) return thresholdTokens;
  if (!(isNumber(thresholdTokens) && thresholdTokens > 0) && isNumber(thresholdPercent) && thresholdPercent > 0) {
    return Math.floor((window * Math.min(99, Math.max(1, thresholdPercent))) / 100);
  }
  return reserveTrigger(window, reserveTokens);
}

// Context usage is the latest prompt size the harness logged (`contextSnapshot.promptTokens`);
// the window, the percentage and the headroom need the model's window, and the headroom also
// the trigger. Each is left out when its input is unknown.
function contextFigure({ modelCatalogue, compactionSettings }) {
  return ({ assistants }) => {
    const figures = {};
    const used = assistants.map((m) => m.contextSnapshot?.promptTokens).filter(isNumber).at(-1);
    if (used !== undefined) figures.contextTokens = used;
    const window = contextWindow(modelCatalogue, assistants.at(-1));
    if (window === undefined) return figures;
    figures.contextMax = window;
    if (used === undefined) return figures;
    figures.contextPercent = used / window;
    const { provider, model } = assistants.at(-1);
    const trigger = compactionTrigger(window, `${provider}/${model}`, compactionSettings());
    if (trigger !== undefined) figures.headroomTokens = Math.max(0, trigger - used);
    return figures;
  };
}

// `sources` are two read-only functions: `modelCatalogue(provider)` gives the model entries
// (`{ id, contextWindow }`) of omp's newest catalogue row of that provider, and
// `compactionSettings()` the `compaction` block of omp's config; each gives undefined when
// unreadable.
export function createOmpProvider(sources) {
  const figures = [...FIGURES, autocompactions, contextFigure(sources)];
  return {
    readStats(input, now) {
      const session = parseSession(input);
      return Object.assign({}, ...figures.map((figure) => figure(session, now)));
    },
  };
}

// Default sources: omp's own files, opened read-only and never written.

// Newest row of the provider's rows (`<provider>:...`), by `updated_at` (D8 (b)).
export function readModelCatalogue(dbPath, provider) {
  const prefix = `${provider}:`;
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query('SELECT models FROM model_cache WHERE substr(provider_id, 1, ?) = ? ORDER BY updated_at DESC LIMIT 1')
      .get(prefix.length, prefix);
    const models = row ? JSON.parse(row.models) : undefined;
    return Array.isArray(models) ? models : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export function readCompactionSettings(configPath) {
  try {
    const compaction = Bun.YAML.parse(readFileSync(configPath, 'utf8'))?.compaction;
    return compaction && typeof compaction === 'object' ? compaction : {};
  } catch {
    return undefined;
  }
}

const OMP_AGENT_DIR = join(homedir(), '.omp', 'agent');

export const ompProvider = createOmpProvider({
  modelCatalogue: (provider) => readModelCatalogue(join(OMP_AGENT_DIR, 'models.db'), provider),
  compactionSettings: () => readCompactionSettings(join(OMP_AGENT_DIR, 'config.yml')),
});
