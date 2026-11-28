import { describe, expect, test } from "bun:test";
import { dependencyMap } from "../herdr-app/mods/usage-queue/graph.js";

const route = { agent: "claude", model: "sonnet", effort: "medium" };
const job = (id, priority = 2, after = null) => ({ id, hash: id, priority, createdAt: priority, after });
const queued = (id) => ({ approval: { hash: id, route } });
const working = (id, at = 1) => ({ approval: { hash: id, route }, launched: { hash: id, at, pr: { mode: "merge", phase: "in-review" } } });
const merged = (id, at = 1) => ({ approval: { hash: id, route }, launched: { hash: id, at, pr: { mode: "merge", phase: "merged" } } });
// [column, row from the bottom, stage]
const place = (map) => Object.fromEntries(map.nodes.map((n) => [n.job.id, [n.col, n.row, n.stage]]));

describe("dependency map", () => {
  test("a chain stands in one column: merged at the bottom, then working, then waiting, latest on top", () => {
    const jobs = [job("a"), job("b", 2, "a"), job("c", 2, "b"), job("d", 2, "c")];
    const state = { jobs: { a: merged("a"), b: working("b"), c: queued("c") } };
    const map = dependencyMap(jobs, state);
    expect(place(map)).toEqual({ a: [0, 0, "done"], b: [0, 1, "working"], c: [0, 2, "waiting"], d: [0, 3, "waiting"] });
    expect(map.edges).toEqual([
      { from: "c", to: "d", met: false },
      { from: "b", to: "c", met: false },
      { from: "a", to: "b", met: true },
    ]);
    expect(map.counts).toEqual({ working: 1, waiting: 2, done: 1 });
    expect([map.cols, map.rows]).toEqual([1, 4]);
    expect(map.bands).toEqual([
      { stage: "done", from: 0, to: 0 },
      { stage: "working", from: 1, to: 1 },
      { stage: "waiting", from: 2, to: 3 },
    ]);
  });

  test("bands line up across trees; siblings stand side by side; trees with work going on come first", () => {
    const jobs = [job("done"), job("root"), job("x", 1, "root"), job("y", 2, "root"), job("later", 2, "y"), job("solo", 3)];
    const state = { jobs: { done: merged("done", 9), root: working("root") } };
    const map = dependencyMap(jobs, state);
    expect(place(map)).toEqual({
      root: [0, 1, "working"], x: [0, 2, "waiting"], y: [1, 2, "waiting"], later: [1, 3, "waiting"],
      solo: [2, 2, "waiting"],
      done: [3, 0, "done"],
    });
    expect(map.bands.map((b) => b.stage)).toEqual(["done", "working", "waiting"]);
  });

  test("finished dependencies stack too: a merged job above the merged job it waited for", () => {
    const jobs = [job("first"), job("second", 2, "first"), job("next", 2, "second")];
    const state = { jobs: { first: merged("first"), second: merged("second", 2) } };
    const map = dependencyMap(jobs, state);
    expect(place(map)).toEqual({ first: [0, 0, "done"], second: [0, 1, "done"], next: [0, 2, "waiting"] });
    expect(map.bands).toEqual([{ stage: "done", from: 0, to: 1 }, { stage: "waiting", from: 2, to: 2 }]);
  });

  test("a job whose job is gone is a root; a hand-made loop still shows every job once", () => {
    expect(place(dependencyMap([job("a", 2, "missing")], { jobs: {} }))).toEqual({ a: [0, 0, "waiting"] });

    const loop = dependencyMap([job("a", 1, "b"), job("b", 2, "a")], { jobs: {} });
    expect(loop.nodes).toHaveLength(2);
    expect(loop.edges).toHaveLength(1);
    expect(new Set(loop.nodes.map((n) => n.row)).size).toBe(2);
  });

  test("a dependency chosen in the allocation wins over the file's", () => {
    const jobs = [job("a"), job("b"), job("c", 2, "a")];
    const state = { jobs: { c: { approval: { hash: "c", route, after: "b" } } } };
    expect(dependencyMap(jobs, state).edges).toEqual([{ from: "b", to: "c", met: false }]);
  });
});
