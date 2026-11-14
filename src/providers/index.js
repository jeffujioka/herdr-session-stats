// Provider registry: the one seam between a harness's session files and the card.
//
// A provider is `{ readStats(input, now) }`, synchronous, and returns a partial stats object.
// `input` is whatever the provider reads from (omp: the jsonl text of the session, or
// `{ text, sources }` with the omp files already read by the caller; opencode: a database
// path); the registry does not look inside it. A provider never reads a file itself: the mod
// does its I/O asynchronously and hands plain values in. `now` is epoch milliseconds; a figure
// measured from the present (cacheLeftMs) reads it, the others ignore it.
//
// A provider may also carry `createSessions({ execOn, readTextOn })`, the hook that finds its
// sessions and reads their plain-value sources; it lives in the provider's own
// `src/providers/<harness>-sources.js`, so adding a harness touches only its provider, its
// sources file and one registry line below. `execOn(machine)` and `readTextOn(machine)` are the
// app's `exec` and `readTextFile` bound to a machine (null: this computer; `exec` also with a
// timeout), read-only use only. `createSessions` runs once per card builder and returns
//   link({ machine, cwd, home, os, now })  -> Promise<{ path, mtimeMs, size } | null>
//     the session file the pane's folder links to (the newest one that changed within
//     LINK_WINDOW_MS, see session-link.js), or null; `home` and `os` (`uname -s`) are the
//     machine's;
//   read(file, { machine, home, now })     -> Promise<input>
//     the `input` of this provider's `readStats` for a linked file.
// Both may reject: the card then reads n/a. A provider without the hook yields no session.
//
// Stats shape (single place; docs/omp-session-format.md repeats it with the omp sources).
// Every figure is a plain value or the string 'n/a' (NA); the card formats, never estimates.
// Units: ms for times, tokens for sizes, USD for money, 0..1 for rates.
//
//   model              string   model of the latest assistant message
//   durationMs         number   first to last message
//   totalTokens        number   sum of usage.totalTokens
//   contextTokens      number   latest context usage
//   contextMax         number   model's maximum context window
//   contextPercent     number   contextTokens / contextMax, 0..1
//   headroomTokens     number   tokens left before the autocompaction trigger
//   autocompactions    number   autocompactions recorded in the session
//   cacheHitRate       number   cacheRead / (input + cacheRead + cacheWrite)
//   cacheHits          number   assistant turns with cacheRead > 0
//   cacheMisses        number   assistant turns with cacheRead 0
//   cacheLeftMs        number   time until the prompt cache is cold; 0 = already cold
//   costUsd            number   sum of the harness's logged cost.total
//   burnCostPerHour    number   costUsd per hour of session
//   burnTokensPerMin   number   totalTokens per minute of session
//   sinceActivityMs    number   now minus the last message
//   latencyMs          number   last turn: assistant reply minus the user message that began it
//   thinkingLevel      string   thinking level of the session
//   premiumRequests    number   sum of usage.premiumRequests
//
// The result of readStats also carries `harness`, the name asked for, which is never n/a.

import { ompProvider } from './omp.js';
import { createOmpSessions } from './omp-sources.js';

export const NA = 'n/a';

export const STAT_FIELDS = [
  'model',
  'durationMs',
  'totalTokens',
  'contextTokens',
  'contextMax',
  'contextPercent',
  'headroomTokens',
  'autocompactions',
  'cacheHitRate',
  'cacheHits',
  'cacheMisses',
  'cacheLeftMs',
  'costUsd',
  'burnCostPerHour',
  'burnTokensPerMin',
  'sinceActivityMs',
  'latencyMs',
  'thinkingLevel',
  'premiumRequests',
];

const providers = new Map();

export function registerProvider(harness, provider) {
  providers.set(harness, provider);
}

// Built-in providers. One line each; omp.js does not import this file, so there is no cycle.
registerProvider('omp', { ...ompProvider, createSessions: createOmpSessions });

// Always returns every field: the provider's value where it gave one, else n/a.
export function readStats(harness, input, now) {
  const provided = providers.get(harness)?.readStats(input, now) ?? {};
  const stats = { harness };
  for (const field of STAT_FIELDS) {
    stats[field] = provided[field] ?? NA;
  }
  return stats;
}

// A provider's session hook for the card builder, or null for a provider without one (its
// harness yields no linked session, so every figure reads n/a). The builder passes the
// provider's `createSessions` the app's I/O bound to a machine, once per builder.
export function createSessions(harness, io) {
  return providers.get(harness)?.createSessions?.(io) ?? null;
}
