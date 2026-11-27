import { describe, expect, test } from "bun:test";
import { DEFAULT_CATALOG } from "../herdr-app/mods/usage-queue/catalog.js";
import { blockedBy, brakeSteps, dueToLaunch, isFinished, SETTLE_MS } from "../herdr-app/mods/usage-queue/queue.js";
import { HOUR, judgeAll } from "../herdr-app/mods/usage-queue/rule.js";

const now = Date.parse("2026-11-27T16:00:00Z");
const job = (id, priority = 2) => ({ id, hash: id, priority, createdAt: 0 });
const pool = (leftPct, readAt = now) => ({
  id: "claude", readAt, ttl: 60_000,
  windows: [{ kind: "5h", label: "5h session", leftPct, resetsAt: now + HOUR, lengthMs: 5 * HOUR }],
});
const run = (id, changes = {}) => ({ hash: id, pool: "claude", at: now - HOUR, ...changes });
const braked = (changes = {}) => ({ at: now - 60_000, reason: "5h session: 25% left", pool: "claude", attempts: 1, ...changes });
const a = job("a");
const steps = (changes, status, pools = [pool(25)], paused = false) => brakeSteps([a],
  { paused, jobs: { a: { launched: run("a", changes) } } }, judgeAll(pools, now), { a: status }, now);

describe("allowance brake", () => {
  test("interrupts only working agents at the reserve or with stale or missing readings", () => {
    expect(steps({}, "working")).toEqual([{ job: a, step: "brake", reason: expect.stringContaining("25% left") }]);
    expect(steps({}, "working", [pool(24)])[0].step).toBe("brake");
    expect(steps({}, "working", [pool(70, now - HOUR)])[0].reason).toContain("stale");
    expect(steps({}, "working", [])[0].reason).toBe("No allowance reading");
    expect(steps({}, "working", [pool(26)])).toEqual([]);
    for (const status of ["idle", "done", "blocked", null, undefined]) expect(steps({}, status)).toEqual([]);
    expect(steps({ noBrake: true }, "working")).toEqual([]);
    expect(steps({ takenOver: true }, "working")).toEqual([]);
    expect(steps({ finishedAt: now - 1 }, "working")).toEqual([]);
  });

  test("retries once while the agent is still working, and recognizes a later takeover", () => {
    expect(steps({ braked: braked() }, "working")[0].step).toBe("retry");
    expect(steps({ braked: braked({ attempts: 2 }) }, "working")).toEqual([]);
    expect(steps({ braked: braked({ attempts: 2 }) }, "idle")[0].step).toBe("observed-stop");
    expect(steps({ braked: braked({ stopped: true }) }, "working")[0].step).toBe("taken-over");
  });

  test("resumes only when the pool opens, or the user chooses Let it finish", () => {
    const changes = { braked: braked({ stopped: true }) };
    expect(steps(changes, "idle", [pool(29)])).toEqual([]);
    expect(steps(changes, "idle", [pool(30)])[0].step).toBe("resume");
    expect(steps(changes, "done", [pool(30)])[0].step).toBe("resume");
    expect(steps(changes, "blocked", [pool(30)])).toEqual([]);
    expect(steps(changes, "idle", [pool(30)], true)).toEqual([]);
    expect(steps({ ...changes, noBrake: true }, "idle")[0].step).toBe("resume");
    expect(steps({ ...changes, noBrake: true }, "idle", [pool(25)], true)).toEqual([]);
    expect(steps({}, "working", [pool(25)], true)[0].step).toBe("brake");
  });

  test("restarts a missing agent with its original job version and waits for unknown statuses", () => {
    const changes = { braked: braked({ stopped: true }) };
    expect(steps(changes, null, [pool(35)])[0].step).toBe("restart");
    expect(steps(changes, undefined, [pool(35)])).toEqual([]);
    expect(steps({ ...changes, hash: "old" }, null, [pool(35)])).toEqual([]);
  });

  test("one resume per pool in priority order, with the same settle period as Auto", () => {
    const b = job("b", 1);
    const c = job("c");
    const jobs = [a, b, c];
    const at = now - SETTLE_MS / 2;
    const state = { jobs: {
      a: { launched: run("a", { braked: braked({ stopped: true }) }) },
      b: { launched: run("b", { braked: braked({ stopped: true }) }) },
      c: { approval: { hash: "c", auto: true, route: { agent: "claude" } } },
    } };
    const pools = [pool(40)];
    const judged = judgeAll(pools, now);
    expect(brakeSteps(jobs, state, judged, { a: "idle", b: "idle" }, now)).toEqual([{ job: b, step: "resume" }]);
    state.jobs.b.launched.at = at;
    expect(brakeSteps(jobs, state, judged, { a: "idle", b: "idle" }, now)).toEqual([]);
    state.jobs.b.launched = run("b", { resumedAt: at });
    expect(brakeSteps(jobs, state, judged, { a: "idle", b: "working" }, now)).toEqual([]);
    expect(dueToLaunch(jobs, state, DEFAULT_CATALOG, pools, judged, now)).toEqual([]);
    expect(dueToLaunch(jobs, state, DEFAULT_CATALOG, pools, judged, now + SETTLE_MS)).toEqual([c]);
  });

  test("a braked job holds its dependents until it's actually finished or marked finished", () => {
    const b = { ...job("b"), after: "a" };
    const state = { jobs: { a: { launched: run("a", { braked: braked(), finishedAt: now }) } } };
    expect(isFinished(state.jobs.a)).toBe(false);
    expect(blockedBy(b, [a, b], state)).toEqual({ job: a, why: "is braked" });
    state.jobs.a.launched.markedFinishedAt = now;
    expect(blockedBy(b, [a, b], state)).toBe(null);
  });
});
