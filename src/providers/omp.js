// omp provider: reads the jsonl text of an omp session (docs/omp-session-format.md) and
// returns the stats of src/providers/index.js that it can read. A figure it cannot read is
// left out, which the registry turns into 'n/a'; nothing here estimates one.
//
// Pure: no herdr, no file or database access. `input` is the jsonl text, `now` epoch ms.
//
// Structure: `parseSession` turns the text into one `session` value; each entry of `FIGURES`
// is a function `(session, now) => partial stats`. A later figure is one more function in the
// list, so adding a figure never rewrites an earlier one.

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
  return { entries, messages, assistants };
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

const FIGURES = [model, duration, tokens, cost];

export const ompProvider = {
  readStats(input, now) {
    const session = parseSession(input);
    return Object.assign({}, ...FIGURES.map((figure) => figure(session, now)));
  },
};
