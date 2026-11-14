// omp provider: reads the jsonl text of an omp session (docs/omp-session-format.md) and
// returns the stats of src/providers/index.js that it can read. A figure it cannot read is
// left out, which the registry turns into 'n/a'; nothing here estimates one.
//
// Pure: no herdr, no file or database access. `input` is the jsonl text.
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
  return { messages, assistants };
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

export const ompProvider = {
  readStats(input, now) {
    const session = parseSession(input);
    return Object.assign({}, ...FIGURES.map((figure) => figure(session, now)));
  },
};
