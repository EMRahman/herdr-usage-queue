import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseOf, lsRemoteHead, remoteHeadRef, resolveBase } from "../herdr-app/mods/usage-queue/base.js";

const runner = (cwd) => async (args) => {
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

let dir, upstream, mine, other;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uq-base-"));
  upstream = join(dir, "upstream.git");
  sh(dir, "init", "-q", "--bare", "-b", "main", upstream);
  sh(dir, "clone", "-q", upstream, "mine");
  mine = join(dir, "mine");
  commit(mine, "a.txt", "one");
  sh(mine, "push", "-q", "origin", "HEAD:main");
  sh(dir, "clone", "-q", upstream, "other");
  other = join(dir, "other");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveBase", () => {
  test("remote: the remote's latest, not your stale or feature-branch checkout", async () => {
    const latest = commit(other, "b.txt", "pushed by someone else");
    sh(other, "push", "-q", "origin", "HEAD:main");
    sh(mine, "checkout", "-qb", "my-feature");
    commit(mine, "c.txt", "unpushed local work");
    const base = await resolveBase(runner(mine), "remote");
    expect(base).toEqual({ ref: "origin/main", commit: latest, note: "" });
  });

  test("local: your checkout's HEAD, unpushed work included", async () => {
    const head = sh(mine, "rev-parse", "HEAD");
    expect(await resolveBase(runner(mine), "local")).toEqual({ ref: "HEAD", commit: head, note: "" });
  });

  test("a branch name: that branch on the remote as just fetched", async () => {
    const tip = commit(other, "d.txt", "release work");
    sh(other, "push", "-q", "origin", "HEAD:release");
    expect(await resolveBase(runner(mine), "release")).toEqual({ ref: "origin/release", commit: tip, note: "" });
  });

  test("a clone that doesn't know the remote's default branch asks the remote", async () => {
    sh(mine, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    expect((await resolveBase(runner(mine), "remote")).ref).toBe("origin/main");
  });

  test("no remote: falls back to the local HEAD and says so", async () => {
    const solo = join(dir, "solo");
    sh(dir, "init", "-q", "solo");
    const head = commit(solo, "x.txt", "x");
    const base = await resolveBase(runner(solo), "remote");
    expect(base.commit).toBe(head);
    expect(base.note).toContain("no remote");
  });

  test("an unreachable remote: falls back to the local HEAD and says so", async () => {
    const lost = join(dir, "lost");
    sh(dir, "clone", "-q", upstream, "lost");
    sh(lost, "remote", "set-url", "origin", join(dir, "gone.git"));
    const base = await resolveBase(runner(lost), "remote");
    expect(base.ref).toBe("HEAD");
    expect(base.note).toContain("Couldn't fetch origin");
  });
});

describe("parsing", () => {
  test("refs and the job's base", () => {
    expect(remoteHeadRef("refs/remotes/origin/main\n", "origin")).toBe("origin/main");
    expect(remoteHeadRef("", "origin")).toBe(null);
    expect(lsRemoteHead("ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n")).toBe("trunk");
    expect(baseOf({})).toBe("remote");
    expect(baseOf({ base: "local" })).toBe("local");
    expect(baseOf({ base: " " })).toBe("remote");
  });
});
