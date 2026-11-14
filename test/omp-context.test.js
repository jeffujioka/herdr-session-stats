import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatContext } from '../src/format.js';
import { NA, readStats, registerProvider } from '../src/providers/index.js';
import {
  createOmpProvider,
  readCompactionSettings,
  readModelCatalogue,
} from '../src/providers/omp.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const fixture = (name) => readFileSync(new URL(`./fixtures/omp/${name}`, import.meta.url), 'utf8');

// One synthetic assistant message entry whose prompt held `promptTokens` tokens.
function assistant(promptTokens, extra = {}) {
  const message = {
    role: 'assistant',
    provider: 'p',
    model: 'm',
    stopReason: 'stop',
    contextSnapshot: { promptTokens },
    ...extra,
  };
  return JSON.stringify({ type: 'message', id: 'a', timestamp: '2026-11-02T11:00:00.000Z', message });
}

// A provider fed by hand-written sources: `models` is what the catalogue lists for any
// provider (undefined = catalogue unreadable), `compaction` the compaction block of
// omp's config (undefined = config unreadable; `{}` = no compaction key). It is read through
// the registry, which fills every figure the provider leaves out with n/a.
function provider(sources) {
  const { models } = sources;
  const compaction = 'compaction' in sources ? sources.compaction : {};
  const omp = createOmpProvider({ modelCatalogue: () => models, compactionSettings: () => compaction });
  registerProvider('omp-context-test', omp);
  return { readStats: (input, now) => readStats('omp-context-test', input, now) };
}

const window200k = [{ id: 'm', contextWindow: 200_000 }];

describe('omp session: context window and autocompactions', () => {
  test('usage over max', () => {
    const stats = provider({ models: window200k }).readStats(assistant(50_000), NOW);

    expect(stats.contextTokens).toBe(50_000);
    expect(stats.contextMax).toBe(200_000);
    expect(stats.contextPercent).toBe(0.25);
    expect(formatContext(stats)).toBe('25%/200k');
  });

  test('usage is the latest assistant message that carries a snapshot', () => {
    const text = [assistant(50_000), assistant(80_000), assistant(undefined, { contextSnapshot: undefined })].join('\n');
    const stats = provider({ models: window200k }).readStats(text, NOW);

    expect(stats.contextTokens).toBe(80_000);
    expect(formatContext(stats)).toBe('40%/200k');
  });

  test('a one-million window reads 1M', () => {
    const models = [{ id: 'claude-sonnet-5.5-1m', contextWindow: 1_000_000 }];
    const text = assistant(250_000, { model: 'claude-sonnet-5.5-1m' });

    expect(formatContext(provider({ models }).readStats(text, NOW))).toBe('25%/1M');
  });

  test('unknown max is n/a', () => {
    const text = assistant(50_000);
    // a trigger is configured, so only the missing window can make the headroom unknown
    const compaction = { thresholdTokens: 150_000 };

    for (const models of [undefined, [], [{ id: 'other', contextWindow: 200_000 }]]) {
      const stats = provider({ models, compaction }).readStats(text, NOW);

      expect(stats.contextMax).toBe(NA);
      expect(stats.contextPercent).toBe(NA);
      expect(stats.headroomTokens).toBe(NA);
      expect(formatContext(stats)).toBe(NA);
    }
  });

  test('counts autocompactions', () => {
    const stats = provider({ models: window200k }).readStats(fixture('compacted.jsonl'), NOW);

    expect(stats.autocompactions).toBe(2);
  });

  test('a whole session without a compaction reads 0', () => {
    expect(provider({ models: window200k }).readStats(fixture('basic.jsonl'), NOW).autocompactions).toBe(0);
  });

  test('unknown compactions is n/a', () => {
    // a tail window that starts after the session header cannot say how many compactions the
    // earlier part held, even when it holds one itself
    const tail = fixture('compacted.jsonl').split('\n').slice(8).join('\n');
    const stats = provider({ models: window200k }).readStats(tail, NOW);

    expect(tail).toContain('"type":"compaction"');
    expect(stats.autocompactions).toBe(NA);
  });

  test('headroom', () => {
    const million = [{ id: 'm', contextWindow: 1_000_000 }];
    const headroom = (models, compaction, used = 600_000) =>
      provider({ models, compaction }).readStats(assistant(used), NOW).headroomTokens;

    // omp's default: window minus max(15% of the window, 16,384), here 850,000 and 170,000
    expect(headroom(million, {})).toBe(250_000);
    expect(headroom(window200k, {}, 50_000)).toBe(120_000);
    // a window under ~109k, where omp's small-window fallback applies, is not evaluated
    expect(headroom([{ id: 'm', contextWindow: 100_000 }], {}, 50_000)).toBe(NA);
    // a reserve that swallows the window is not evaluated either
    expect(headroom(million, { reserveTokens: 1_000_000 })).toBe(NA);
    // an explicit reserve above the 15% floor
    expect(headroom(million, { reserveTokens: 200_000 })).toBe(200_000);
    // an explicit token trigger wins over a percentage
    expect(headroom(million, { thresholdTokens: 700_000, thresholdPercent: 50 })).toBe(100_000);
    // a percentage of the window
    expect(headroom(million, { thresholdPercent: 80 })).toBe(200_000);
    // a token trigger at or past the window falls back to the default
    expect(headroom(million, { thresholdTokens: 1_000_000 })).toBe(250_000);
    // usage past the trigger leaves nothing
    expect(headroom(million, {}, 900_000)).toBe(0);
  });

  test('unknown trigger is n/a headroom', () => {
    const text = assistant(50_000);
    const unknowns = [
      undefined, // config unreadable
      { modelThresholds: { 'p/m': 'f90000' } }, // a per-model entry the mod does not evaluate
      { modelThresholds: { 'p/*': '80%' } },
      { enabled: false }, // no autocompaction at all
    ];

    for (const compaction of unknowns) {
      const stats = provider({ models: window200k, compaction }).readStats(text, NOW);

      expect(stats.headroomTokens).toBe(NA);
      // the context over max still shows
      expect(formatContext(stats)).toBe('25%/200k');
    }
  });

  test('a model threshold for another model does not hide the headroom', () => {
    const compaction = { modelThresholds: { 'p/other': 'f90000', 'q/*': 90000 } };
    const stats = provider({ models: window200k, compaction }).readStats(assistant(50_000), NOW);

    expect(stats.headroomTokens).toBe(120_000);
  });

  test('model thresholds off leave the default', () => {
    const compaction = { modelThresholdsEnabled: false, modelThresholds: { 'p/m': 'f90000' } };
    const stats = provider({ models: window200k, compaction }).readStats(assistant(50_000), NOW);

    expect(stats.headroomTokens).toBe(120_000);
  });
});

describe('omp readers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-context-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function catalogue(rows) {
    const path = join(dir, `models-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(path);
    db.run('CREATE TABLE model_cache (provider_id TEXT NOT NULL, updated_at INTEGER NOT NULL, models TEXT NOT NULL)');
    for (const [id, updatedAt, models] of rows) {
      db.run('INSERT INTO model_cache VALUES (?, ?, ?)', [id, updatedAt, JSON.stringify(models)]);
    }
    db.close();
    return path;
  }

  test('catalogue reads the newest row of the provider', () => {
    const path = catalogue([
      ['gh:models-v2:old', 100, [{ id: 'm', contextWindow: 1 }]],
      ['gh:models-v2:new', 300, [{ id: 'm', contextWindow: 3 }]],
      ['gh:models-v2:mid', 200, [{ id: 'm', contextWindow: 2 }]],
      ['ghx:models-v2:newer', 400, [{ id: 'm', contextWindow: 4 }]],
    ]);

    expect(readModelCatalogue(path, 'gh')).toEqual([{ id: 'm', contextWindow: 3 }]);
    expect(readModelCatalogue(path, 'none')).toBeUndefined();
    expect(readModelCatalogue(join(dir, 'missing.db'), 'gh')).toBeUndefined();
  });

  test('catalogue is read only', () => {
    const path = catalogue([['gh:models-v2:a', 1, []]]);
    readModelCatalogue(path, 'gh');
    const db = new Database(path, { readonly: true });

    expect(db.query('SELECT count(*) AS n FROM model_cache').get().n).toBe(1);
    db.close();
  });

  test('compaction settings read the compaction block of the config', () => {
    const path = join(dir, 'config.yml');
    writeFileSync(path, 'theme:\n  dark: x\ncompaction:\n  thresholdPercent: 80\n');

    expect(readCompactionSettings(path)).toEqual({ thresholdPercent: 80 });
    writeFileSync(path, 'theme:\n  dark: x\n');
    expect(readCompactionSettings(path)).toEqual({});
  });

  test('unreadable config has no settings', () => {
    const path = join(dir, 'broken.yml');
    writeFileSync(path, 'compaction: [unclosed\n  - : :');

    expect(readCompactionSettings(join(dir, 'missing.yml'))).toBeUndefined();
    expect(readCompactionSettings(path)).toBeUndefined();
  });
});
