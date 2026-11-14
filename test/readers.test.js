import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readCompactionSettings, readModelCatalogue } from '../src/readers-bun.js';

const SRC = new URL('../src/', import.meta.url).pathname;

describe('files the mod bundles', () => {
  test('are runtime-neutral', () => {
    // The mod runs in herdr's JS runtime: no bun:/node: import and no Bun global. Only
    // src/readers-bun.js, which no mod file imports, may use them.
    const files = readdirSync(SRC, { recursive: true })
      .filter((file) => file.endsWith('.js') && file !== 'readers-bun.js')
      .map((file) => join(SRC, file));
    const offenders = files
      .filter((file) => /(?:from|import|require)\s*\(?\s*['"](?:bun|node):|\bBun\./.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(files.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('bun-only readers of omp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-readers-'));
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
    expect(readModelCatalogue(path, 'none')).toBeNull();
    expect(readModelCatalogue(join(dir, 'missing.db'), 'gh')).toBeNull();
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

    expect(readCompactionSettings(join(dir, 'missing.yml'))).toBeNull();
    expect(readCompactionSettings(path)).toBeNull();
  });
});
