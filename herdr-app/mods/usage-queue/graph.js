// The dependency map: every job on a grid, finished ones at the bottom, then working ones, then
// waiting ones, furthest from running at the top. Each job sits above the job it waits for.
// Pure: jobs and state in, positions and edges out.

import { classify, isFinished, waitFor } from "./queue.js";

/** Where a job is: "working" (launched, not finished), "waiting" (not launched) or "done"
 *  (launched and finished: merged, its agent done, or marked finished). */
export function stageOf(job, launchedIds, state) {
  if (!launchedIds.has(job.id)) return "waiting";
  return isFinished(state.jobs?.[job.id]) ? "done" : "working";
}

/** The bands, bottom to top. */
export const STAGES = ["done", "working", "waiting"];
const STAGE_RANK = { working: 0, waiting: 1, done: 2 };

/**
 * The map's layout. A job waits for at most one other, so the jobs form trees.
 *
 * Rows (counted from the bottom): one band per stage, done, then working, then waiting. Within a
 * band a job goes one row up for each job of its own stage that it waits for, directly or further
 * down the chain, so a waiting job that waits for another waiting job runs later and sits higher.
 * Two jobs in one chain never share a row.
 *
 * Columns: a tree per column group, a job in its first child's column, so a chain is one straight
 * line. Trees with something working come first, then ones with something waiting, then finished
 * ones. A job whose job is gone is a root; a loop (only from hand-edited files) is cut.
 *
 * Returns { nodes: [{ job, stage, col, row }], edges: [{ from, to, met }], counts, cols, rows,
 * bands: [{ stage, from, to }] } with `bands` holding each non-empty band's rows (from ≤ row ≤ to)
 * and `met` when the job waited for is finished.
 */
export function dependencyMap(jobs, state) {
  const { queued, launched } = classify(jobs, state);
  const launchedIds = new Set(launched.map((j) => j.id));
  const order = [...launched, ...queued];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const stage = new Map(jobs.map((j) => [j.id, stageOf(j, launchedIds, state)]));
  const parent = new Map();
  for (const job of jobs) {
    const after = waitFor(job, state);
    if (after && after !== job.id && byId.has(after)) parent.set(job.id, after);
  }
  // Cut loops: walking up from any job must end. The first job found to close a loop loses its edge.
  for (const job of order) {
    const seen = new Set([job.id]);
    for (let id = job.id; parent.has(id);) {
      const up = parent.get(id);
      if (seen.has(up)) { parent.delete(id); break; }
      seen.add(up);
      id = up;
    }
  }
  const children = new Map();
  for (const job of order) {
    const p = parent.get(job.id);
    if (p) children.set(p, [...(children.get(p) ?? []), job]);
  }

  // The most urgent stage in a job's tree, for ordering: anything working puts it first.
  const best = new Map();
  const bestOf = (job) => {
    if (!best.has(job.id)) {
      let rank = STAGE_RANK[stage.get(job.id)];
      for (const c of children.get(job.id) ?? []) rank = Math.min(rank, bestOf(c));
      best.set(job.id, rank);
    }
    return best.get(job.id);
  };
  const sorted = (list) => [...list].sort((a, b) => bestOf(a) - bestOf(b) || order.indexOf(a) - order.indexOf(b));

  // How far up its band a job sits: the jobs of its own stage it waits for.
  const level = (job) => {
    let n = 0;
    for (let id = parent.get(job.id); id; id = parent.get(id)) if (stage.get(id) === stage.get(job.id)) n++;
    return n;
  };

  const nodes = [], edges = [];
  let next = 0;
  const place = (job) => {
    const kids = sorted(children.get(job.id) ?? []);
    // The first child takes this column (`next` hasn't moved), so a chain stays on one line.
    const node = { job, stage: stage.get(job.id), col: next, level: level(job) };
    nodes.push(node);
    if (!kids.length) next++;
    for (const c of kids) {
      place(c);
      edges.push({ from: job.id, to: c.id, met: isFinished(state.jobs?.[job.id]) });
    }
  };
  for (const job of sorted(order.filter((j) => !parent.has(j.id)))) place(job);

  const bands = [];
  let base = 0;
  for (const s of STAGES) {
    const own = nodes.filter((n) => n.stage === s);
    if (!own.length) continue;
    const height = Math.max(...own.map((n) => n.level)) + 1;
    for (const n of own) n.row = base + n.level;
    bands.push({ stage: s, from: base, to: base + height - 1 });
    base += height;
  }
  for (const n of nodes) delete n.level;

  const counts = { working: 0, waiting: 0, done: 0 };
  for (const n of nodes) counts[n.stage]++;
  return { nodes, edges, counts, cols: next, rows: base, bands };
}
