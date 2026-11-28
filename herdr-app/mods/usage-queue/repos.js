// Repos to offer in the add dialog: the focused pane's, those open in spaces, then those of
// recent jobs. Each folder counts as its repo's main checkout, so every worktree of a repo is
// one choice, and folders that aren't in a git repo are left out.

export const MAX_REPOS = 6;

/**
 * The main checkout of the repo holding `folder`, or null when it isn't in one. `git` runs git in
 * a folder and resolves with { ok, out }.
 */
export async function mainCheckout(git, folder) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return null;
  const common = await git(top.out, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.ok && /\/\.git\/?$/.test(common.out) ? common.out.replace(/\/\.git\/?$/, "") : top.out;
}

/**
 * Folders in order of preference become [{ path, name, folders }]: `path` the main checkout,
 * `folders` every listed folder in it (so a job saved with a worktree's folder still matches).
 * `resolve` maps a folder to its main checkout, or null.
 */
export async function activeRepos(folders, resolve, max = MAX_REPOS) {
  const unique = [...new Set(folders.filter(Boolean))];
  const mains = await Promise.all(unique.map((f) => resolve(f).catch(() => null)));
  const byPath = new Map();
  unique.forEach((folder, i) => {
    const path = mains[i];
    if (!path) return;
    if (!byPath.has(path)) byPath.set(path, { path, name: path.split("/").filter(Boolean).at(-1) ?? path, folders: [path] });
    const repo = byPath.get(path);
    if (!repo.folders.includes(folder)) repo.folders.push(folder);
  });
  return [...byPath.values()].slice(0, max);
}
