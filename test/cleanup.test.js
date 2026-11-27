import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanUpMerged, cleanupEntry, parseWorktrees } from "../herdr-app/mods/usage-queue/cleanup.js";

const git = async (cwd, args) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const sh = (cwd, ...args) => {
  const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
const commit = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-qm", text);
  return sh(cwd, "rev-parse", "HEAD");
};
const branchExists = (cwd, branch) => Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd }).exitCode === 0;
const onRemote = (cwd, branch) => sh(cwd, "ls-remote", "--heads", "origin", `refs/heads/${branch}`) !== "";

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A repo with a job's worktree whose branch was pushed and squash-merged on the remote. */
let repo, tree, branch, head;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "uq-cleanup-"));
  dirs.push(dir);
  const upstream = join(dir, "upstream.git");
  sh(dir, "init", "-q", "--bare", "-b", "main", upstream);
  sh(dir, "clone", "-q", upstream, "repo");
  repo = join(dir, "repo");
  commit(repo, "a.txt", "one");
  sh(repo, "push", "-q", "origin", "HEAD:main");
  branch = "queue/job-1-20261127-1200";
  tree = join(dir, "worktrees", "queue-job-1");
  sh(repo, "worktree", "add", "-q", "-b", branch, tree, "origin/main");
  commit(tree, "b.txt", "the job's work");
  head = commit(tree, "c.txt", "a review round");
  sh(tree, "push", "-q", "origin", branch);
  // GitHub's squash merge: one new commit on main, so main doesn't contain the branch's commits.
  sh(dir, "clone", "-q", upstream, "merger");
  const merger = join(dir, "merger");
  sh(merger, "merge", "-q", "--squash", `origin/${branch}`);
  sh(merger, "commit", "-qm", "Squashed (#1)");
  sh(merger, "push", "-q", "origin", "HEAD:main");
});

const clean = (extra = {}) => cleanUpMerged({ git, repo, branch, number: 1, headOid: head, ...extra });

describe("cleanUpMerged", () => {
  test("a merged job: its worktree, local branch and GitHub branch all go", async () => {
    expect(await clean()).toEqual({ status: "done", reason: "", removed: ["worktree", "branch", "origin branch"] });
    expect(existsSync(tree)).toBe(false);
    expect(branchExists(repo, branch)).toBe(false);
    expect(onRemote(repo, branch)).toBe(false);
  });

  test("GitHub already deleted its branch: the local leftovers still go", async () => {
    sh(repo, "push", "-q", "origin", "--delete", branch);
    expect(await clean()).toEqual({ status: "done", reason: "", removed: ["worktree", "branch"] });
  });

  test("uncommitted or untracked files: everything is kept", async () => {
    writeFileSync(join(tree, "notes.txt"), "not committed");
    const r = await clean();
    expect(r.status).toBe("kept");
    expect(r.reason).toContain("uncommitted or untracked");
    expect(r.removed).toEqual([]);
    expect(existsSync(join(tree, "notes.txt"))).toBe(true);
    expect(branchExists(repo, branch)).toBe(true);
    expect(onRemote(repo, branch)).toBe(true);
  });

  test("untracked files in a repo that hides them from status: still kept", async () => {
    sh(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(tree, "notes.txt"), "not committed");
    const r = await clean();
    expect(r).toMatchObject({ status: "kept", removed: [] });
    expect(existsSync(join(tree, "notes.txt"))).toBe(true);
  });

  test("a commit while its space closes: everything is kept", async () => {
    const r = await clean({ freeFolder: async () => { commit(tree, "g.txt", "committed while closing"); return ""; } });
    expect(r).toMatchObject({ status: "kept", removed: [] });
    expect(r.reason).toContain("moved");
    expect(existsSync(tree)).toBe(true);
  });

  test("a commit just before the worktree goes: the branch is kept", async () => {
    const raced = async (cwd, args) => {
      if (args.includes("worktree") && args.includes("remove")) commit(tree, "h.txt", "committed just before removal");
      return git(cwd, args);
    };
    const r = await clean({ git: raced });
    expect(r).toMatchObject({ status: "kept", removed: ["worktree"] });
    expect(branchExists(repo, branch)).toBe(true);
    expect(sh(repo, "log", "-1", "--format=%s", branch)).toBe("committed just before removal");
  });

  test("a commit made after the PR's head: everything is kept", async () => {
    commit(tree, "d.txt", "more work after the merge");
    const r = await clean();
    expect(r).toMatchObject({ status: "kept", removed: [] });
    expect(r.reason).toContain("aren't in PR #1");
    expect(existsSync(tree)).toBe(true);
  });

  test("a push to the GitHub branch after the merge: local goes, GitHub's is kept", async () => {
    const other = join(repo, "..", "other");
    sh(join(repo, ".."), "clone", "-q", join(repo, "..", "upstream.git"), "other");
    sh(other, "checkout", "-q", branch);
    commit(other, "e.txt", "pushed later");
    sh(other, "push", "-q", "origin", branch);
    sh(repo, "fetch", "-q", "origin");
    const r = await clean();
    expect(r).toMatchObject({ status: "kept", removed: ["worktree", "branch"] });
    expect(r.reason).toContain("on origin has commits that aren't in PR #1");
    expect(onRemote(repo, branch)).toBe(true);
  });

  test("a push to the GitHub branch while it's being deleted: the delete is refused", async () => {
    const other = join(repo, "..", "other");
    sh(join(repo, ".."), "clone", "-q", join(repo, "..", "upstream.git"), "other");
    sh(other, "checkout", "-q", branch);
    const raced = async (cwd, args) => {
      // Someone pushes after ls-remote read the branch, just before the delete.
      if (args[0] === "push") {
        commit(other, "f.txt", "pushed mid-cleanup");
        sh(other, "push", "-q", "origin", branch);
      }
      return git(cwd, args);
    };
    const r = await clean({ git: raced });
    expect(r).toMatchObject({ status: "kept", removed: ["worktree", "branch"] });
    expect(sh(other, "ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s+/)[0]).toBe(sh(other, "rev-parse", "HEAD"));
  });

  test("its space can't close yet: waits, and nothing is removed", async () => {
    const r = await clean({ freeFolder: async (path) => (path === realpathSync(tree) ? "Its agent is still working." : "") });
    expect(r).toEqual({ status: "wait", reason: "Its agent is still working.", removed: [] });
    expect(existsSync(tree)).toBe(true);
    expect(branchExists(repo, branch)).toBe(true);
  });

  test("the worktree folder was deleted by hand: git forgets it and the branches go", async () => {
    rmSync(tree, { recursive: true, force: true });
    expect(await clean()).toEqual({ status: "done", reason: "", removed: ["branch", "origin branch"] });
    expect(sh(repo, "worktree", "list")).not.toContain("queue-job-1");
  });

  test("the branch is checked out in the main checkout: kept", async () => {
    sh(repo, "worktree", "remove", tree);
    sh(repo, "checkout", "-q", branch);
    const r = await clean();
    expect(r).toMatchObject({ status: "kept", removed: [] });
    expect(r.reason).toContain("main checkout");
  });

  test("a head commit it can't get: waits", async () => {
    const r = await clean({ headOid: "0123456789abcdef0123456789abcdef01234567" });
    expect(r.status).toBe("wait");
    expect(existsSync(tree)).toBe(true);
  });

  test("nothing left (already cleaned up): done, nothing to remove", async () => {
    await clean();
    expect(await clean()).toEqual({ status: "done", reason: "", removed: [] });
  });
});

describe("parseWorktrees", () => {
  test("reads paths, branches, locks and the main checkout", () => {
    const out = [
      "worktree /code/repo\nHEAD aaa\nbranch refs/heads/main",
      "worktree /wt/queue-x\nHEAD bbb\nbranch refs/heads/queue/x-1\nlocked in use",
      "worktree /wt/gone\nHEAD ccc\nbranch refs/heads/queue/y-2\nprunable gitdir file points to non-existent location",
      "worktree /wt/detached\nHEAD ddd\ndetached",
    ].join("\n\n");
    expect(parseWorktrees(out)).toEqual([
      { path: "/code/repo", branch: "main", locked: false, prunable: false, main: true },
      { path: "/wt/queue-x", branch: "queue/x-1", locked: true, prunable: false, main: false },
      { path: "/wt/gone", branch: "queue/y-2", locked: false, prunable: true, main: false },
      { path: "/wt/detached", branch: null, locked: false, prunable: false, main: false },
    ]);
  });
});

describe("cleanupEntry", () => {
  test("keeps what's needed after the job is deleted", () => {
    const job = { id: "job-1", title: "A job", repo: "~/Code/x" };
    const launched = { folder: "/wt/queue-job-1", branch: "queue/job-1-20261127-1200" };
    expect(cleanupEntry(job, launched, 7, 123)).toEqual({
      job: "job-1", title: "A job", repo: "~/Code/x", folder: "/wt/queue-job-1", branch: "queue/job-1-20261127-1200", number: 7, at: 123,
    });
  });
});
