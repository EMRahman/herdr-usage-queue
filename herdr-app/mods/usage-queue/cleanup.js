// After a job's PR merges: remove its worktree, its local branch and, if GitHub kept it, the
// branch there. No Herdr imports: `git(cwd, args)` is passed in, so tests run it against real
// repositories.
//
// Nothing is removed unless all of it is in the merged PR. The branch's commits must be in the
// PR's head (squash merges leave them out of main, so main can't tell), the worktree must have
// no uncommitted or untracked files, and the GitHub branch must still point inside the PR.
// Otherwise it's kept, with the reason.

/** A pending cleanup, saved in state.json's `cleanups` by branch: it outlives the job. */
export function cleanupEntry(job, launched, number, now = Date.now()) {
  return {
    job: job.id, title: job.title, repo: job.repo, folder: launched.folder, branch: launched.branch, number, at: now,
  };
}

/** `git worktree list --porcelain` as [{ path, branch, locked, prunable, main }]. */
export function parseWorktrees(output) {
  return String(output ?? "").split(/\n\n+/).map((r) => r.split("\n")).filter((r) => r[0]?.startsWith("worktree "))
    .map((fields, i) => ({
      path: fields[0].slice("worktree ".length),
      branch: fields.find((f) => f.startsWith("branch "))?.slice("branch refs/heads/".length) ?? null,
      locked: fields.some((f) => f === "locked" || f.startsWith("locked ")),
      prunable: fields.some((f) => f === "prunable" || f.startsWith("prunable ")),
      main: i === 0,
    }));
}

/** Ignored folders that builds and installs recreate: a worktree holding only these can go. */
const REBUILDABLE_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  "dist", "build", ".build", "target", "DerivedData", ".gradle", ".next", ".nuxt", ".svelte-kit", ".turbo",
  ".parcel-cache", ".cache", "coverage", ".nyc_output", "test-results", "playwright-report",
]);
const REBUILDABLE_FILES = /(^|\/)(\.DS_Store|Thumbs\.db)$|\.(pyc|pyo|log|tsbuildinfo)$/;

/** Whether an ignored path (as `git status --ignored=matching` lists it) is safe to lose. Anything
 *  else ignored, such as a `.env` or a local database, may be someone's data. */
export function rebuildable(path) {
  const clean = path.replace(/\/+$/, "");
  return clean.split("/").some((part) => REBUILDABLE_DIRS.has(part)) || REBUILDABLE_FILES.test(clean);
}

/** `git status --porcelain -z` output: the ignored paths ("!! "). */
export function ignoredPaths(output) {
  return String(output ?? "").split("\0").filter((e) => e.startsWith("!! ")).map((e) => e.slice(3));
}

/** `git ls-files -s -v -z` output: the files git is told not to look at (skip-worktree "S",
 *  assume-unchanged lowercase), whose edits status and `worktree remove` can't see.
 *  [{ path, blob }]. */
export function hiddenFromStatus(output) {
  return String(output ?? "").split("\0").map((e) => e.match(/^(\S) \d+ ([0-9a-f]+) \d+\t(.+)$/s))
    .filter((m) => m && (m[1] === "S" || m[1] !== m[1].toUpperCase()))
    .map((m) => ({ path: m[3], blob: m[2] }));
}

/** At most this many hidden files are compared one by one; more keeps the worktree. */
const HIDDEN_CHECK_MAX = 50;

const short = (err, fallback) => String(err ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) || fallback;

/**
 * Removes what a merged job left behind. `headOid` is the PR's head commit as GitHub has it.
 * `freeFolder(path)` closes the worktree's space if it has one; it resolves with "" when nothing
 * is open there any more, else why the worktree has to wait (it may have just started closing).
 *
 * Resolves with { status, reason, removed }:
 *   "done": nothing of the job's is left (removed lists what went now);
 *   "wait": try again later (reason says why);
 *   "kept": something can't go without losing work, or git refused; don't try again.
 */
export async function cleanUpMerged({ git, repo, branch, number, headOid, freeFolder = async (_path) => "" }) {
  const removed = [];
  const wait = (reason) => ({ status: "wait", reason, removed });
  const kept = (reason) => ({ status: "kept", reason, removed });
  const done = () => ({ status: "done", reason: "", removed });
  const run = (args, timeout) => git(repo, args, timeout);

  const remotes = (await run(["remote"])).out.split("\n").map((r) => r.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!headOid) return wait(`Couldn't read PR #${number}'s head commit.`);
  // The worktree has the PR's commits unless someone else pushed to it: then fetch them.
  if (!(await run(["cat-file", "-e", `${headOid}^{commit}`])).ok) {
    if (remote) await run(["fetch", "--quiet", remote, `refs/pull/${number}/head`], 120_000);
    if (!(await run(["cat-file", "-e", `${headOid}^{commit}`])).ok) return wait(`Couldn't fetch PR #${number}'s commits.`);
  }
  const inPR = async (commit) => commit === headOid || (await run(["merge-base", "--is-ancestor", commit, headOid])).ok;

  const tip = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (tip.ok && !(await inPR(tip.out))) return kept(`${branch} has commits that aren't in PR #${number}.`);

  const list = await run(["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]);
  if (!list.ok) return wait(short(list.err, "git worktree list failed."));
  let tree = parseWorktrees(list.out).find((w) => w.branch === branch);
  if (tree?.prunable) {
    // Its folder is already gone: let git forget it.
    await run(["worktree", "prune"]);
    tree = null;
  }
  if (tree) {
    if (tree.main) return kept(`${branch} is checked out in your main checkout.`);
    if (tree.locked) return kept(`The worktree at ${tree.path} is locked.`);
    // Untracked files are asked for: status.showUntrackedFiles=no would hide them otherwise.
    const status = await run(["-C", tree.path, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
    if (!status.ok) return wait(short(status.err, "git status failed."));
    if (status.out) return kept(`The worktree at ${tree.path} has uncommitted or untracked files.`);
    // Edits to files flagged skip-worktree or assume-unchanged don't show anywhere: compare each
    // one on disk with the index. A missing one loses nothing (git has it).
    const flags = await run(["-C", tree.path, "ls-files", "-s", "-v", "-z"]);
    if (!flags.ok) return wait(short(flags.err, "git ls-files failed."));
    const hidden = hiddenFromStatus(flags.out);
    if (hidden.length > HIDDEN_CHECK_MAX) {
      return kept(`The worktree at ${tree.path} has ${hidden.length} files git is told not to check for edits.`);
    }
    for (const file of hidden) {
      const hash = await run(["-C", tree.path, "hash-object", "--", file.path]);
      // Only a file that isn't there is let go: unreadable (permission denied) can't be checked.
      if (hash.ok ? hash.out !== file.blob : !/No such file or directory/.test(hash.err)) {
        return kept(`The worktree at ${tree.path} has edits git is told to ignore (skip-worktree or assume-unchanged): ${file.path}.`);
      }
    }
    // `worktree remove` deletes ignored files without --force: keep any that aren't rebuildable.
    const ignored = await run(["-C", tree.path, "--no-optional-locks", "status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=all"]);
    if (!ignored.ok) return wait(short(ignored.err, "git status failed."));
    const keep = ignoredPaths(ignored.out).filter((p) => !rebuildable(p));
    if (keep.length) {
      const named = keep.slice(0, 3).join(", ") + (keep.length > 3 ? ` and ${keep.length - 3} more` : "");
      return kept(`The worktree at ${tree.path} has ignored files that may be yours: ${named}.`);
    }
    const busy = await freeFolder(tree.path);
    if (busy) return wait(busy);
    // Its agent may have committed while its space was closing: check the tip again.
    const now = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (now.out !== tip.out) return kept(`${branch} moved while it was being cleaned up.`);
    // No --force, and untracked files counted whatever the repo's setting: git still refuses if
    // anything changed since the check above.
    const gone = await run(["-c", "status.showUntrackedFiles=all", "worktree", "remove", tree.path], 120_000);
    if (!gone.ok) return kept(short(gone.err, "git worktree remove failed."));
    removed.push("worktree");
  }

  if (tip.ok) {
    // Not `branch -D`: a squash-merged branch isn't merged as git sees it, so delete the ref
    // only if it's still the commit inPR() checked. A later commit keeps the branch.
    const deleted = await run(["update-ref", "-d", `refs/heads/${branch}`, tip.out]);
    if (!deleted.ok) return kept(`${branch} has commits that aren't in PR #${number}.`);
    removed.push("branch");
  }

  if (remote) {
    const heads = await run(["ls-remote", "--heads", remote, `refs/heads/${branch}`], 60_000);
    if (!heads.ok) return wait(short(heads.err, `Couldn't reach ${remote}.`));
    const sha = heads.out.split(/\s+/)[0];
    if (sha) {
      // A push after the merge isn't in the PR: leave the branch for you.
      const known = (await run(["cat-file", "-e", `${sha}^{commit}`])).ok;
      if (!known || !(await inPR(sha))) return kept(`${branch} on ${remote} has commits that aren't in PR #${number}.`);
      // The lease makes the remote refuse if the branch moved since ls-remote read it.
      const pushed = await run(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${sha}`, remote, "--delete", branch], 120_000);
      if (!pushed.ok) return kept(short(pushed.err, `Couldn't delete ${branch} on ${remote}.`));
      removed.push(`${remote} branch`);
    }
  }
  return done();
}
