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
