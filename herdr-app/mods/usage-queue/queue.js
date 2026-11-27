// Jobs and their place in the flow: Pending Launch Approval → Ready to Launch → Launched.
// Pure: job files, state and judgements in; lists and choices out.

import { agentOf, estimators, modelOf, poolFor, poolsOfAgent } from "./catalog.js";
import { baseOf } from "./base.js";
import { prModeOf } from "./review.js";
import { better } from "./rule.js";

/** A job file's contents, checked. Returns { job } or { error }. */
export function readJob(id, text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { error: `Not valid JSON: ${e.message}` }; }
  if (!raw || typeof raw !== "object") return { error: "Not a JSON object." };
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { error: "No prompt." };
  const repo = raw.where?.worktree?.repo ?? raw.repo;
  if (typeof repo !== "string" || !repo.trim()) return { error: "No repository (where.worktree.repo)." };
  const agents = Array.isArray(raw.agents) && raw.agents.length ? raw.agents.map(String) : ["claude"];
  return {
    job: {
      id,
      title: String(raw.about ?? raw.title ?? prompt.split("\n")[0]).trim().slice(0, 120),
      prompt,
      repo: repo.trim(),
      agents,
      priority: Number.isInteger(raw.priority) ? raw.priority : 3,
      model: raw.model && typeof raw.model === "object" ? raw.model : {},
      effort: raw.effort && typeof raw.effort === "object" ? raw.effort : {},
      launch: raw.launch === "auto" ? "auto" : "approve",
      base: baseOf(raw),
      pr: prModeOf(raw),
      raw,
    },
  };
}

/** A new job file's text. */
export function jobText({ title, prompt, repo, agents, priority, pr = "off" }) {
  return JSON.stringify({
    about: title, prompt, where: { worktree: { repo } }, agents, priority, launch: "approve", pr,
  }, null, 2) + "\n";
}

/** A file name for a new job: its title as a slug plus the time. */
export function jobId(title, now = Date.now()) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";
  return `${slug}-${now.toString(36)}`;
}

const byPriority = (a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * Split jobs into the three lists. An approval counts only for the job file it was given for:
 * a changed file goes back to Pending Launch Approval.
 */
export function classify(jobs, state) {
  const pending = [], ready = [], launched = [];
  for (const job of jobs) {
    const s = state.jobs?.[job.id] ?? {};
    const approved = s.approval && s.approval.hash === job.hash;
    if (approved && s.launched?.hash === job.hash) launched.push(job);
    else if (approved) ready.push(job);
    else pending.push(job);
  }
  const launchedAt = (j) => state.jobs?.[j.id]?.launched?.at ?? 0;
  return {
    pending: pending.sort(byPriority),
    ready: ready.sort(byPriority),
    launched: launched.sort((a, b) => launchedAt(b) - launchedAt(a)),
  };
}

/** One light per agent: the best of its pools' judgements. */
export function agentLights(catalog, pools, judged) {
  return catalog.agents.map((agent) => {
    const own = poolsOfAgent(agent, pools);
    let best = null;
    for (const p of own) best = better(best, judged[p.id]);
    return { agent, pools: own, judgement: best };
  }).filter((l) => l.pools.length);
}

/**
 * The big models that can run an estimate, each with its pool's judgement, best first.
 * suggested: the green one with the most waste, else the yellow one with the most headroom.
 */
export function estimatorChoices(catalog, pools, judged, jobAgents = null) {
  const choices = estimators(catalog).map(({ agent, model }) => {
    const pool = poolFor(agent, model.id, pools);
    const judgement = pool ? judged[pool.id] : null;
    return { agent, model, pool, judgement, usable: Boolean(judgement && judgement.light !== "red") };
  });
  const score = (c) => !c.judgement ? -1 : c.judgement.light === "green" ? 2000 + c.judgement.waste
    : c.judgement.light === "yellow" ? 1000 + c.judgement.headroom : 0;
  // A tie goes to an agent the job itself may use: it already knows the job's setup.
  const own = (c) => (jobAgents?.includes(c.agent.id) ? 0.5 : 0);
  choices.sort((a, b) => score(b) + own(b) - (score(a) + own(a)));
  const suggested = choices.find((c) => c.usable) ?? null;
  return { choices, suggested };
}

/** A route's pool and judgement: where an approved or proposed job would run. */
export function routeStatus(catalog, route, pools, judged) {
  const agent = agentOf(catalog, route?.agent);
  const pool = agent ? poolFor(agent, route.model, pools) : null;
  const judgement = pool ? judged[pool.id] : null;
  return { agent, pool, judgement: judgement ?? { light: "red", reason: "No allowance reading for this model" } };
}

/**
 * The proposal to show from an estimate: the route with the greenest, most urgent pool;
 * ties go to the estimator's recommendation.
 */
export function proposeRoute(catalog, estimate, pools, judged) {
  if (!estimate?.routes?.length) return null;
  const rank = { green: 2, yellow: 1, red: 0 };
  const recommended = (r) => Number(r.agent === estimate.recommended);
  const scored = estimate.routes.map((route) => ({ route, j: routeStatus(catalog, route, pools, judged).judgement }));
  scored.sort((a, b) => rank[b.j.light] - rank[a.j.light] || (b.j.urgency ?? 0) - (a.j.urgency ?? 0)
    || recommended(b.route) - recommended(a.route) || (b.j.headroom ?? 0) - (a.j.headroom ?? 0));
  return { ...scored[0].route };
}

/**
 * Scheduled jobs ("launch when there's allowance") to launch now: approved, not launched, their
 * route's light not red; by priority, at most one per pool, and none on a pool something launched
 * on within `settleMs` (readings lag use). Nothing while paused.
 */
export function dueToLaunch(jobs, state, catalog, pools, judged, now = Date.now(), settleMs = 10 * 60_000) {
  if (state.paused) return [];
  const settling = new Set(Object.values(state.jobs ?? {})
    .filter((s) => s.launched?.pool && now - s.launched.at < settleMs).map((s) => s.launched.pool));
  const due = [];
  for (const job of classify(jobs, state).ready) {
    const approval = state.jobs?.[job.id]?.approval;
    if (!approval?.auto) continue;
    const { pool, judgement } = routeStatus(catalog, approval.route, pools, judged);
    if (!pool || judgement.light === "red" || settling.has(pool.id)) continue;
    settling.add(pool.id);
    due.push(job);
  }
  return due;
}

/** A route pinned by the job file itself (model and effort for one agent), or null. */
export function pinnedRoute(catalog, job) {
  for (const id of job.agents) {
    const agent = agentOf(catalog, id);
    const model = job.model?.[id];
    const effort = job.effort?.[id];
    if (agent && modelOf(agent, model) && agent.efforts.includes(effort)) {
      return { agent: id, model, effort, size: "m", why: "Set in the job file." };
    }
  }
  return null;
}
