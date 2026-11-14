// Bun-only readers of omp's files, for tests and local checks. NOT part of the mod: nothing
// under src/ imports this file, since herdr's runtime has no bun:sqlite or Bun global. The
// mod resolves the same two sources itself with the app's async `exec` and `readTextFile`
// and hands them to the omp provider as plain values (`sources`, src/providers/omp.js).
//
// Both open omp's files read-only and never write them. Each gives null when the file or the
// row cannot be read.

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

// Model entries of the newest row (by `updated_at`) of the provider's rows `<provider>:...`
// in omp's `models.db` (docs/omp-session-format.md, D8 (b)): the `catalogue` source.
export function readModelCatalogue(dbPath, provider) {
  const prefix = `${provider}:`;
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query('SELECT models FROM model_cache WHERE substr(provider_id, 1, ?) = ? ORDER BY updated_at DESC LIMIT 1')
      .get(prefix.length, prefix);
    const models = row ? JSON.parse(row.models) : null;
    return Array.isArray(models) ? models : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// The `compaction` block of omp's `config.yml` (`{}` when it has none): the `compaction` source.
export function readCompactionSettings(configPath) {
  try {
    const compaction = Bun.YAML.parse(readFileSync(configPath, 'utf8'))?.compaction;
    return compaction && typeof compaction === 'object' ? compaction : {};
  } catch {
    return null;
  }
}
