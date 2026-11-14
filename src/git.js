// Read-only git facts for a card (D9): the branch and the origin remote URL of a pane's
// folder. Runtime-neutral: the mod passes in herdr's async `exec(command, args, options)`
// (`{ code, stdout, stderr }`), tests pass in a fake of the same signature. Only
// `git branch --show-current` and `git remote get-url origin` are run, in the pane's folder
// through `cwd`, so no path is an argument; neither writes, and no shell string or
// redirection is used.

// One git fact: the first line git prints, or null when git fails (not a repository, no
// origin remote), prints nothing (a detached HEAD has no branch), or cannot be run at all
// (no such folder, the machine is unreachable). A card shows no line for a null.
async function ask(exec, args, options) {
  try {
    const { code, stdout } = await exec('git', args, options);
    if (code !== 0) return null;
    const line = stdout.split('\n', 1)[0].trim();
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

// `pane`: `{ cwd, on }`, a pane's folder and the machine it is on (null or absent for this
// computer, where `on` is left out of the call). The commands run on that machine, not here.
// A pane without a folder is not asked: git would answer for herdr's own folder.
// Resolves to `{ branch, origin }`, each a string or null.
export async function readGit({ exec }, { cwd, on }) {
  if (!cwd) return { branch: null, origin: null };
  const options = on ? { cwd, on } : { cwd };
  const [branch, origin] = await Promise.all([
    ask(exec, ['branch', '--show-current'], options),
    ask(exec, ['remote', 'get-url', 'origin'], options),
  ]);
  return { branch, origin };
}
