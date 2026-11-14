// Claude Code provider: reads the jsonl text of a Claude Code session
// (docs/claude-session-format.md) and returns the stats of src/providers/index.js that it can
// read. A figure it cannot read is left out, which the registry turns into 'n/a'; nothing here
// estimates one, and there is no price table.
//
// Pure: no herdr, no file access, no runtime-specific API, so the mod can bundle it. `input`
// is the jsonl text of the session or `{ text, sources }` (see `claudeProvider`).
//
// Structure as in omp.js: `parseSession` turns the text into one `session` value, and each
// entry of `FIGURES` is a function `(session, now, sources) => partial stats`.

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

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// A user entry that carries a tool's result continues a turn; any other (not meta) one starts it.
const isPrompt = ({ message, isMeta }) =>
  !isMeta && (typeof message.content === 'string' || (Array.isArray(message.content) && !message.content.some((part) => part?.type === 'tool_result')));

// What Claude Code writes in place of an API reply it never got (an error, an interruption);
// its usage is all zeros and it is no turn.
const SYNTHETIC_MODEL = '<synthetic>';

function parseSession(text) {
  // user and assistant entries, with the entry's own ISO timestamp as epoch ms
  const messages = [];
  // API responses, once each: Claude Code writes a response as one entry per content block,
  // every one with the response's `message.id` and the same usage. The later entry replaces
  // the earlier, so a response is dated by its last block.
  const assistants = [];
  const slots = new Map();
  let logged;
  let compactions = 0;
  for (const entry of parseEntries(text)) {
    const { message } = entry;
    const time = Date.parse(entry.timestamp);
    if ((entry.type === 'user' || entry.type === 'assistant') && message && typeof message === 'object' && isNumber(time)) {
      messages.push({ role: entry.type, time, prompt: entry.type === 'user' && isPrompt(entry) });
      if (entry.type === 'assistant' && message.model !== SYNTHETIC_MODEL) {
        const response = { message, time };
        const slot = typeof message.id === 'string' ? slots.get(message.id) : undefined;
        if (slot === undefined) {
          if (typeof message.id === 'string') slots.set(message.id, assistants.length);
          assistants.push(response);
        } else {
          assistants[slot] = response;
        }
        if (logged) logged.stale = true;
      }
    } else if (entry.type === 'cost-state') {
      logged = { usd: entry.totalCostUSD, stale: false };
    } else if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.compactMetadata?.trigger === 'auto') {
      compactions += 1;
    }
  }
  return { messages, assistants, logged, compactions };
}

// Sum of `pick(assistant message)` over the responses that have it; undefined when none has.
function sumAssistants(session, pick) {
  const values = session.assistants.map(({ message }) => pick(message)).filter(isNumber);
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

const inputTokens = (m) => m.usage?.input_tokens;
const outputTokens = (m) => m.usage?.output_tokens;
const cacheRead = (m) => m.usage?.cache_read_input_tokens;
const cacheWrite = (m) => m.usage?.cache_creation_input_tokens;

// A response's four token counts added; one that lacks a count has no total.
function responseTokens(m) {
  const counts = [inputTokens(m), outputTokens(m), cacheRead(m), cacheWrite(m)];
  return counts.every(isNumber) ? counts.reduce((a, b) => a + b, 0) : undefined;
}

function model({ assistants }) {
  const latest = assistants.at(-1)?.message.model;
  return typeof latest === 'string' && latest ? { model: latest } : {};
}

// First to last message, by the entries' own ISO timestamps.
function duration({ messages }) {
  return messages.length ? { durationMs: messages.at(-1).time - messages[0].time } : {};
}

function tokens(session) {
  const totalTokens = sumAssistants(session, responseTokens);
  return totalTokens === undefined ? {} : { totalTokens };
}

// Hit rate is over the session's token counts (D6); it needs all three counts to be logged
// and a non-zero total.
function cacheRate(session) {
  const input = sumAssistants(session, inputTokens);
  const read = sumAssistants(session, cacheRead);
  const write = sumAssistants(session, cacheWrite);
  if (input === undefined || read === undefined || write === undefined) return {};
  const total = input + read + write;
  return total > 0 ? { cacheHitRate: read / total } : {};
}

// A response is a hit when its cache read is above 0 and a miss when it is 0 (D6); one that
// logged no cache read is neither.
function cacheTurns({ assistants }) {
  const reads = assistants.map(({ message }) => cacheRead(message)).filter(isNumber);
  if (!reads.length) return {};
  const cacheHits = reads.filter((read) => read > 0).length;
  return { cacheHits, cacheMisses: reads.length - cacheHits };
}

// `usage.cache_creation` splits the tokens written to the cache by lifetime class.
const CACHE_LIFETIME_MS = {
  ephemeral_5m_input_tokens: 5 * 60 * 1000,
  ephemeral_1h_input_tokens: 60 * 60 * 1000,
};

// Time left on the prompt cache after the last response, counted from its last block; 0 once
// it has expired. The class is the one the response wrote tokens under; a response that wrote
// none, or logged no split, leaves it unknown.
function cacheExpiry({ assistants }, now) {
  const last = assistants.at(-1);
  const written = last?.message.usage?.cache_creation ?? {};
  const lifetimes = Object.keys(CACHE_LIFETIME_MS)
    .filter((key) => written[key] > 0)
    .map((key) => CACHE_LIFETIME_MS[key]);
  if (!lifetimes.length || !isNumber(now)) return {};
  return { cacheLeftMs: Math.max(0, last.time + Math.max(...lifetimes) - now) };
}

// Compactions Claude Code itself started: `compact_boundary` entries whose
// `compactMetadata.trigger` is `auto`. Counting needs the whole file; a tail window can hold
// only some of them, so without `sources.wholeFile` it is unknown, never 0.
function autocompactions({ compactions }, now, sources) {
  return sources.wholeFile === true ? { autocompactions: compactions } : {};
}

// Context usage is the prompt of the latest response: input plus the cache it read and wrote.
// The files hold no window for the model, so there is no maximum, percentage or headroom.
function context({ assistants }) {
  const m = assistants.at(-1)?.message;
  const counts = m && [inputTokens(m), cacheRead(m), cacheWrite(m)];
  return counts?.every(isNumber) ? { contextTokens: counts.reduce((a, b) => a + b, 0) } : {};
}

// Cost is the session total Claude Code logs in a `cost-state` entry (D5), which it writes
// when a session is saved, not per turn. A response after the last such entry is not in it, so
// the total is stale and is not shown.
function cost({ logged }) {
  return logged && !logged.stale && isNumber(logged.usd) ? { costUsd: logged.usd } : {};
}

// Token burn is derived from the session's own duration and token figures; a session that has
// not lasted (duration 0) or lacks the input reads n/a. A cost per hour would divide a total
// logged at save time by the time read here, so there is none.
function burnRate(session) {
  const { durationMs } = duration(session);
  const { totalTokens } = tokens(session);
  return durationMs > 0 && totalTokens !== undefined ? { burnTokensPerMin: totalTokens / (durationMs / 60000) } : {};
}

// Time since the last message entry, by its ISO timestamp, like the duration.
function sinceActivity({ messages }, now) {
  return messages.length && isNumber(now) ? { sinceActivityMs: now - messages.at(-1).time } : {};
}

// Last turn: the last assistant entry minus the prompt that began its turn (the nearest
// prompt before it; the tool results in between do not begin one).
function latency({ messages }) {
  const reply = messages.findLastIndex((e) => e.role === 'assistant');
  const began = messages.findLastIndex((e, i) => i < reply && e.prompt);
  return reply < 0 || began < 0 ? {} : { latencyMs: messages[reply].time - messages[began].time };
}

const FIGURES = [model, duration, tokens, cacheRate, cacheTurns, cacheExpiry, autocompactions, context, cost, burnRate, sinceActivity, latency];

// `input` is the jsonl text, or `{ text, sources }` where `sources` holds what the caller
// knows besides the text: `wholeFile`, true when the text is the whole file and not a tail
// window. A source that is absent reads as unknown.
export const claudeProvider = {
  readStats(input, now) {
    const { text, sources } = typeof input === 'string' ? { text: input } : input;
    const session = parseSession(text);
    return Object.assign({}, ...FIGURES.map((figure) => figure(session, now, sources ?? {})));
  },
};
