import { describe, expect, test } from 'bun:test';
import { LINK_WINDOW_MS, collapseBySession, linkSession } from '../src/session-link.js';

const NOW = Date.parse('2026-05-01T12:00:00Z');
const MIN = 60_000;
const file = (path, minutesAgo) => ({ path, mtimeMs: NOW - minutesAgo * MIN });

describe('Pane to session link', () => {
  test('newest file wins', () => {
    const files = [file('/s/c.jsonl', 9), file('/s/a.jsonl', 1), file('/s/b.jsonl', 2)];

    expect(linkSession(files, NOW)).toBe('/s/a.jsonl');
  });

  test('stale file is not linked', () => {
    expect(LINK_WINDOW_MS).toBe(5 * MIN);
    expect(linkSession([file('/s/old.jsonl', 20)], NOW)).toBeNull();
  });

  test('no files is not linked', () => {
    expect(linkSession([], NOW)).toBeNull();
  });
});

describe('One card per agent pane', () => {
  test('same session collapses to one', () => {
    const panes = [
      { paneId: 'p1', sessionPath: '/s/a.jsonl' },
      { paneId: 'p2', sessionPath: '/s/a.jsonl' },
      { paneId: 'p3', sessionPath: '/s/b.jsonl' },
      { paneId: 'p4', sessionPath: null },
      { paneId: 'p5', sessionPath: null },
    ];

    const cards = collapseBySession(panes);

    expect(cards.map((pane) => pane.paneId)).toEqual(['p1', 'p3', 'p4', 'p5']);
  });
});
