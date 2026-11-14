// omp provider: reads the jsonl text of an omp session (docs/omp-session-format.md) and
// returns the stats of src/providers/index.js that it can read. A figure it cannot read is
// left out, which the registry turns into 'n/a'; nothing here estimates one.
//
// Pure: no herdr, no file or database access, no runtime-specific API, so the mod can bundle
// it. `input` is the jsonl text of the session or `{ text, sources }` (see `ompProvider`).
//
// Structure: `parseSession` turns the text into one `session` value; each entry of `FIGURES`
// is a function `(session, now) => partial stats` (`now` is epoch ms; only a figure that
// measures from the present reads it). A later figure is one more function in the list, so
// adding a figure never rewrites an earlier one.

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

// Compactions recorded in the session (docs/omp-session-format.md, D8 (a)): omp does not
// mark automatic ones, so this counts all `compaction` entries. Counting needs the whole
// file; a tail window can hold only some of them, so it reads n/a, never 0.
function autocompactions({ fromStart, compactions }) {
  return fromStart ? { autocompactions: compactions } : {};
}

// Window of the latest assistant message's model, from omp's model catalogue (D8 (b)).
function contextWindow(catalogue, { provider, model } = {}) {
  if (typeof provider !== 'string' || typeof model !== 'string' || !Array.isArray(catalogue)) return undefined;
  const window = catalogue.find((entry) => entry?.id === model)?.contextWindow;
  return isNumber(window) && window > 0 ? window : undefined;
}

// The default reserve and its 15% floor are omp's own rule: omp://compaction.md "Settings and
// defaults" (`compaction.reserveTokens`: "the effective reserve is `max(floor(contextWindow x
// 0.15), configuredReserve ?? 16384)`") and omp://settings.md (`compaction.thresholdTokens`,
// `thresholdPercent`, `modelThresholds`); the code of omp 18.20.2 agrees. On a 1M window the
// trigger is 850,000.
const DEFAULT_RESERVE = 16384;

// Trigger of the reserve-based default. Not evaluated (undefined) for a window whose 15% is
// under the default reserve, where omp's doc only says the budget "uses the proportional
// reserve when the unset default is impractical on a small window" (omp://compaction.md),
// without saying where that starts; nor for a reserve that reaches the whole window.
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
function context({ assistants, sources }) {
  const figures = {};
  const used = assistants.map((m) => m.contextSnapshot?.promptTokens).filter(isNumber).at(-1);
  if (used !== undefined) figures.contextTokens = used;
  const window = contextWindow(sources.catalogue, assistants.at(-1));
  if (window === undefined) return figures;
  figures.contextMax = window;
  if (used === undefined) return figures;
  figures.contextPercent = used / window;
  const { provider, model } = assistants.at(-1);
  const trigger = compactionTrigger(window, `${provider}/${model}`, sources.compaction);
  if (trigger !== undefined) figures.headroomTokens = Math.max(0, trigger - used);
  return figures;
}

const FIGURES = [model, duration, tokens, cost, cacheRate, cacheTurns, cacheExpiry, autocompactions, context];

// `input` is the jsonl text, or `{ text, sources }` where `sources` holds the two omp files
// the context figures need, already read by the caller (the mod reads them asynchronously):
// `catalogue`, the model entries (`{ id, contextWindow }`) of the session's provider from
// omp's newest catalogue row, and `compaction`, the `compaction` block of omp's config
// (`{}` when it has none). A source that could not be read is null or absent.
export const ompProvider = {
  readStats(input, now) {
    const { text, sources } = typeof input === 'string' ? { text: input } : input;
    const session = { ...parseSession(text), sources: sources ?? {} };
    return Object.assign({}, ...FIGURES.map((figure) => figure(session, now)));
  },
};

