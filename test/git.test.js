import { describe, expect, test } from 'bun:test';
import { readGit } from '../src/git.js';

// Stand-in with the exact signature of herdr's `exec(command, args, options)`, answering the
// two read-only git commands the way git does: `git branch --show-current` prints the branch
// (nothing on a detached HEAD) and exits 128 outside a repository; `git remote get-url origin`
// prints the URL and exits 2 when there is no such remote. Keeps every call. `repos` maps a
// machine (`null` for this computer) to a map of folder -> { branch, origin }; anything else is
// not a repository there. A program that cannot start (unreachable machine) rejects.
function fakeExec(repos, { unreachable = [] } = {}) {
  const calls = [];
  async function exec(command, args = [], options = {}) {
    calls.push({ command, args, options });
    const machine = options.on ?? null;
    if (unreachable.includes(machine)) throw new Error(`machine ${machine} is unreachable`);
    if (command !== 'git') throw new Error(`unexpected program ${command}`);
    const repo = repos[machine]?.[options.cwd];
    if (!repo) return { code: 128, stdout: '', stderr: 'fatal: not a git repository\n' };
    if (args.join(' ') === 'branch --show-current') return { code: 0, stdout: `${repo.branch ?? ''}\n`, stderr: '' };
    if (args.join(' ') === 'remote get-url origin') {
      return repo.origin == null
        ? { code: 2, stdout: '', stderr: "error: No such remote 'origin'\n" }
        : { code: 0, stdout: `${repo.origin}\n`, stderr: '' };
    }
    throw new Error(`unexpected git arguments ${args.join(' ')}`);
  }
  return { exec, calls };
}

const ORIGIN = 'git@github.com:jeffujioka/herdr-session-stats.git';

describe('git', () => {
  test('branch and origin', async () => {
    const { exec, calls } = fakeExec({ null: { '/work/app': { branch: 'feat/cards', origin: ORIGIN } } });
    expect(await readGit({ exec }, { cwd: '/work/app' })).toEqual({ branch: 'feat/cards', origin: ORIGIN });
    expect(calls.map((call) => [call.command, call.args, call.options.cwd])).toEqual([
      ['git', ['branch', '--show-current'], '/work/app'],
      ['git', ['remote', 'get-url', 'origin'], '/work/app'],
    ]);
  });

  test('no git means no lines', async () => {
    const none = fakeExec({});
    expect(await readGit({ exec: none.exec }, { cwd: '/tmp/plain' })).toEqual({ branch: null, origin: null });

    const noOrigin = fakeExec({ null: { '/work/local': { branch: 'main', origin: null } } });
    expect(await readGit({ exec: noOrigin.exec }, { cwd: '/work/local' })).toEqual({ branch: 'main', origin: null });

    const detached = fakeExec({ null: { '/work/d': { branch: null, origin: ORIGIN } } });
    expect(await readGit({ exec: detached.exec }, { cwd: '/work/d' })).toEqual({ branch: null, origin: ORIGIN });
  });

  test('remote pane uses on', async () => {
    const { exec, calls } = fakeExec({
      null: { '/work/app': { branch: 'here', origin: 'https://example.com/here.git' } },
      'dev-box': { '/work/app': { branch: 'there', origin: ORIGIN } },
    });
    expect(await readGit({ exec }, { cwd: '/work/app', on: 'dev-box' })).toEqual({ branch: 'there', origin: ORIGIN });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.options.on).toBe('dev-box');

    // a pane on this computer is asked here: no `on`
    calls.length = 0;
    expect(await readGit({ exec }, { cwd: '/work/app', on: null })).toEqual({
      branch: 'here',
      origin: 'https://example.com/here.git',
    });
    for (const call of calls) expect('on' in call.options).toBe(false);
  });

  test('an unreachable machine or a missing folder shows no lines', async () => {
    const { exec } = fakeExec({}, { unreachable: ['down'] });
    expect(await readGit({ exec }, { cwd: '/work/app', on: 'down' })).toEqual({ branch: null, origin: null });
    expect(await readGit({ exec }, { cwd: null })).toEqual({ branch: null, origin: null });
  });
});
