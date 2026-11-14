import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NA, readStats } from '../src/providers/index.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/omp/${name}`, import.meta.url), 'utf8');

// One synthetic assistant message entry; `usage` is left out when null.
function assistant(isoTime, usage) {
  const message = { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop' };
  if (usage) message.usage = usage;
  return JSON.stringify({ type: 'message', id: 'a', timestamp: isoTime, message });
}

describe('omp session: model, duration, tokens and cost', () => {
  test('model, duration and total tokens', () => {
    const stats = readStats('omp', fixture('basic.jsonl'), Date.now());

    expect(stats.harness).toBe('omp');
    expect(stats.model).toBe('claude-sonnet-5.5-1m');
    // first message 10:05:41.002Z, last message 10:15:39.629Z
    expect(stats.durationMs).toBe(598627);
    expect(stats.totalTokens).toBe(18078 + 23061 + 16429 + 21210);
  });

  test('missing usage field is n/a', () => {
    const stats = readStats('omp', fixture('no-usage.jsonl'), Date.now());

    expect(stats.totalTokens).toBe(NA);
    expect(stats.costUsd).toBe(NA);
    // the other figures still show
    expect(stats.model).toBe('claude-sonnet-5.5-1m');
    expect(stats.durationMs).toBe(5031); // 10:05:41.002Z to 10:05:46.033Z
  });

  test('cost sums cost.total', () => {
    const usage = (total) => ({ totalTokens: 10, cost: { total } });
    const text = [
      assistant('2026-11-02T10:00:00.000Z', usage(0.1)),
      assistant('2026-11-02T10:01:00.000Z', usage(0.25)),
      assistant('2026-11-02T10:02:00.000Z', usage(0.15)),
    ].join('\n');

    expect(readStats('omp', text, Date.now()).costUsd).toBeCloseTo(0.5, 10);
  });
});
