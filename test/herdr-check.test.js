import { describe, expect, test } from 'bun:test';

const root = new URL('..', import.meta.url).pathname;

// scripts/sync.sh copies src/ into the mod folder and runs `herdr-app check` on it, so this one
// run covers the generated mod as the app loads it (the mod imports the copied modules).
describe('herdr-app check', () => {
  test('herdr-app check passes', () => {
    const sync = Bun.spawnSync(['sh', 'scripts/sync.sh'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const output = `${sync.stdout.toString()}${sync.stderr.toString()}`;
    expect(output).toContain('check passed');
    expect(sync.exitCode).toBe(0);

    const check = Bun.spawnSync(['herdr-app', 'check', 'mods/herdr-session-stats'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(`${check.stdout.toString()}${check.stderr.toString()}`).toContain('check passed');
    expect(check.exitCode).toBe(0);
  });
});
