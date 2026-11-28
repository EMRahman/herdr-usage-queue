import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkJob, jobFromOptions, run, statusOf } from "../herdr-app/mods/usage-queue/cli.js";
import { readJob } from "../herdr-app/mods/usage-queue/queue.js";

const job = (id, extra = {}) => readJob(id, JSON.stringify({ prompt: "Do it", repo: "~/r", ...extra })).job;
const text = (extra = {}) => JSON.stringify({ prompt: "Do it", repo: "~/r", ...extra });
const route = { agent: "claude", model: "sonnet", effort: "medium" };

describe("checkJob", () => {
  test("a plain job is fine", () => {
    expect(checkJob("a", text())).toMatchObject({ errors: [], warnings: [] });
  });

  test("a file the mod can't read is an error", () => {
    expect(checkJob("a", "{").errors[0]).toContain("Not valid JSON");
    expect(checkJob("a", JSON.stringify({ repo: "~/r" })).errors).toEqual(["No prompt."]);
  });

  test("fields that aren't built, or aren't fields, are warned about", () => {
    const { errors, warnings } = checkJob("a", text({ repeat: "weekly", maxMinutes: 4, colour: "red", where: { background: { cwd: "/x" } } }));
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toContain(`"repeat" isn't built yet`);
    expect(warnings.join("\n")).toContain(`"maxMinutes" isn't built yet`);
    expect(warnings.join("\n")).toContain(`"colour" isn't a job field`);
    expect(warnings.join("\n")).toContain("background");
  });

  test("unknown agents, models and efforts are errors; pinned pools aren't built", () => {
    expect(checkJob("a", text({ agents: ["clod"] })).errors[0]).toContain(`Unknown agent "clod"`);
    expect(checkJob("a", text({ agents: ["claude:work"] })).errors[0]).toContain("isn't built yet");
    expect(checkJob("a", text({ model: { claude: "opux" }, effort: { claude: "medium" } })).errors[0]).toContain(`no model "opux"`);
    expect(checkJob("a", text({ model: { claude: "opus" }, effort: { claude: "huge" } })).errors[0]).toContain(`no effort "huge"`);
    expect(checkJob("a", text({ model: { claude: "opus" } })).warnings[0]).toContain(`no "effort"`);
  });

  test("an agent that can't run the permission profile", () => {
    const catalog = { agents: [{ id: "x", name: "X", models: [], efforts: [] }] };
    expect(checkJob("a", text({ agents: ["x"], permissions: "plan" }), { catalog }).errors[0]).toContain("can't run the Plan profile");
  });

  test("after: a missing job is an error, a deleted one a warning, a loop an error", () => {
    const jobs = [job("b", { after: "a" }), job("c")];
    expect(checkJob("a", text({ after: "nope" }), { jobs }).errors[0]).toContain("no job named nope");
    expect(checkJob("a", text({ after: "gone" }), { jobs, state: { jobs: {}, deleted: { gone: 1 } } }).warnings[0]).toContain("was deleted");
    expect(checkJob("a", text({ after: "b" }), { jobs }).errors[0]).toContain("a loop");
    expect(checkJob("a", text({ after: "c" }), { jobs }).errors).toEqual([]);
  });

  test("a repo that isn't there", () => {
    expect(checkJob("a", text(), { repoExists: () => false }).errors[0]).toContain("isn't a git checkout");
  });
});

describe("statusOf", () => {
  const a = { ...job("a"), hash: "ha", createdAt: 1 };
  const b = { ...job("b", { after: "a" }), hash: "hb", createdAt: 2 };
  const jobs = [a, b];

  test("before launch: needs allocation, waiting, saved, auto", () => {
    expect(statusOf(a, jobs, { jobs: {} }).phase).toBe("needs-allocation");
    expect(statusOf(b, jobs, { jobs: {} })).toMatchObject({ phase: "waiting", text: "Waits for a, which isn't launched yet" });
    expect(statusOf(a, jobs, { jobs: { a: { approval: { hash: "ha", route } } } }).phase).toBe("saved");
    expect(statusOf(a, jobs, { jobs: { a: { approval: { hash: "ha", route, auto: true } } } }).phase).toBe("auto");
  });

  test("after launch: working, braked, PR, needs you, done", () => {
    const launched = (l) => ({ jobs: { a: { approval: { hash: "ha", route }, launched: { hash: "ha", at: 1, ...l } } } });
    expect(statusOf(a, jobs, launched({})).phase).toBe("working");
    expect(statusOf(a, jobs, launched({ braked: { reason: "stale reading" } })).text).toBe("Braked: stale reading");
    expect(statusOf(a, jobs, launched({ pr: { mode: "review", phase: "in-review", number: 4, rounds: 1 } })).text).toBe("PR #4 · review round 1");
    expect(statusOf(a, jobs, launched({ pr: { mode: "review", phase: "needs-you", number: 4 } })).phase).toBe("needs-you");
    expect(statusOf(a, jobs, launched({ pr: { mode: "merge", phase: "merged", number: 4 } })).text).toBe("Merged #4");
    expect(statusOf(a, jobs, launched({ finishedAt: 2 })).phase).toBe("done");
  });

  test("an edited job is back in the queue", () => {
    const state = { jobs: { a: { approval: { hash: "old", route }, launched: { hash: "old", at: 1 } } } };
    expect(statusOf(a, jobs, state).phase).toBe("needs-allocation");
  });
});

test("add's options become a job file the mod reads back the same", () => {
  const raw = jobFromOptions({ title: "Fix", agents: "claude, codex", model: ["claude=opus"], effort: ["claude=high"],
    priority: "2", pr: "review", permissions: "edit", after: "x", auto: true }, " Fix it \n", "~/r");
  const { job } = readJob("j", JSON.stringify(raw));
  expect(job).toMatchObject({ title: "Fix", prompt: "Fix it", repo: "~/r", agents: ["claude", "codex"], priority: 2,
    launch: "auto", pr: "review", permissions: "edit", after: "x", model: { claude: "opus" }, effort: { claude: "high" } });
});

describe("the commands, end to end", () => {
  let dir, base, repo, worktree;
  const git = (cwd, ...args) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const cli = (...argv) => {
    const lines = [];
    const code = run(argv, { base, out: (l) => lines.push(l) });
    return { code, out: lines.join("\n") };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "uq-cli-"));
    base = join(dir, "usage-queue");
    repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "start");
    worktree = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", worktree);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("add writes a job file for the main checkout, even from a worktree", () => {
    const r = cli("add", "--prompt", "Write the docs", "--title", "Docs", "--repo", worktree, "--id", "docs", "--json");
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out);
    expect(result).toMatchObject({ id: "docs", written: true, errors: [] });
    const file = JSON.parse(readFileSync(join(base, "jobs", "docs.json"), "utf8"));
    expect(file.where.worktree.repo).toBe(Bun.spawnSync(["realpath", repo]).stdout.toString().trim().replace(process.env.HOME, "~"));
    expect(readdirSync(join(base, "jobs"))).toEqual(["docs.json"]); // no temp file left behind
  });

  test("add refuses a bad after, a taken id, and writes nothing", () => {
    expect(cli("add", "--prompt", "x", "--repo", repo, "--after", "nope").code).toBe(1);
    expect(cli("add", "--prompt", "x", "--repo", repo, "--id", "docs").out).toContain("already a job named docs");
    expect(readdirSync(join(base, "jobs"))).toEqual(["docs.json"]);
  });

  test("a chain: add with --after, then list and status", () => {
    expect(cli("add", "--prompt", "Then publish", "--repo", repo, "--id", "publish", "--after", "docs").code).toBe(0);
    const { jobs } = JSON.parse(cli("list", "--json").out);
    expect(jobs.map((j) => [j.id, j.phase])).toEqual([["docs", "needs-allocation"], ["publish", "waiting"]]);
    const status = JSON.parse(cli("status", "publish", "--json").out);
    expect(status).toMatchObject({ id: "publish", after: "docs", phase: "waiting", allocation: null, launched: null });
  });

  test("--dry-run checks without writing", () => {
    const r = cli("add", "--prompt", "Try", "--repo", repo, "--id", "try", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain('"prompt": "Try"');
    expect(existsSync(join(base, "jobs", "try.json"))).toBe(false);
  });

  test("validate reports each file, and fails on errors", () => {
    expect(cli("validate").code).toBe(0);
    writeFileSync(join(base, "jobs", "bad.json"), JSON.stringify({ prompt: "x", repo, after: "missing", deadline: "2027-01-01" }));
    const r = cli("validate", "--json");
    expect(r.code).toBe(1);
    const bad = JSON.parse(r.out).results.find((x) => x.id === "bad");
    expect(bad.errors[0]).toContain("no job named missing");
    expect(bad.warnings[0]).toContain(`"deadline" isn't built yet`);
    expect(cli("validate", "docs").code).toBe(0);
  });

  test("status of a job that isn't there, and usage errors", () => {
    expect(cli("status", "nope").code).toBe(1);
    expect(cli("add", "--repo", repo).code).toBe(2);
    expect(cli("frobnicate").code).toBe(2);
    expect(cli("--help").code).toBe(0);
  });
});
