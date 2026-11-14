// Text of the card's figures. Takes stats as `readStats` returns them: a number or 'n/a'.

import { NA } from './providers/index.js';

// A token count as the card writes a size: 200000 is "200k", 1000000 is "1M".
export function formatTokens(tokens) {
  if (tokens < 1e3) return String(tokens);
  const thousands = Math.round(tokens / 1e3);
  return thousands < 1e3 ? `${thousands}k` : `${+(tokens / 1e6).toFixed(1)}M`;
}

// Context as usage percent over the maximum window, "25%/200k". Without the maximum nothing
// can be shown, so it reads 'n/a'; with the maximum but no usage it reads "n/a of 200k".
export function formatContext({ contextPercent, contextMax }) {
  if (contextMax === NA) return NA;
  if (contextPercent === NA) return `${NA} of ${formatTokens(contextMax)}`;
  return `${Math.round(contextPercent * 100)}%/${formatTokens(contextMax)}`;
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
export function describeCard({ folder, branch, origin, harnessName, stats }) {
  const hasCounts = stats.cacheHits !== NA && stats.cacheMisses !== NA;
  const rate = via(stats.cacheHitRate, (r) => `${Math.round(r * 100)}%`);
  const burn =
    stats.burnCostPerHour === NA && stats.burnTokensPerMin === NA
      ? NA
      : `${via(stats.burnCostPerHour, (c) => `$${c.toFixed(2)}/h`)}, ${via(stats.burnTokensPerMin, (t) => `${formatTokens(Math.round(t))} tok/min`)}`;
  return {
    title: harnessName,
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
