import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

// The mod runs in herdr's JS runtime: no bun:/node: import, no Bun global, no TextEncoder and
// no setInterval (the mod has the timer of its `cx`). Only the install (src/install-lib.js)
// runs in bun, and it is not copied into the mod.
const FORBIDDEN = /(?:from|import|require)\s*\(?\s*['"](?:bun|node):|\bBun\.|\bTextEncoder\b|\bsetInterval\b/;

// A comment line may name what the code avoids.
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

describe('files the mod bundles', () => {
  test('are runtime-neutral', () => {
    const files = readdirSync(SRC, { recursive: true })
      .filter((file) => file.endsWith('.js') && file !== 'install-lib.js')
      .map((file) => join(SRC, file));
    const offenders = files.filter((file) => FORBIDDEN.test(code(readFileSync(file, 'utf8')))).map((file) => relative(SRC, file));

    expect(files.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('the check sees what it forbids', () => {
    for (const text of ["import { x } from 'node:fs';", 'const t = Bun.file(p);', 'new TextEncoder().encode(s)', 'setInterval(f, 1)']) {
      expect(FORBIDDEN.test(code(text))).toBe(true);
    }
    expect(FORBIDDEN.test(code("// no TextEncoder here\nimport { x } from './y.js';"))).toBe(false);
  });
});
