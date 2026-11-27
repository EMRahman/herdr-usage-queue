// Jobs in the launch queue and launch history.
// Pure: job files, state and judgements in; lists and choices out.

import { agentOf, estimators, modelOf, PERMISSION_PROFILES, poolFor, poolsOfAgent, supportsPermissions } from "./catalog.js";
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
  const permissions = raw.permissions === undefined ? "default" : raw.permissions;
  if (typeof permissions !== "string" || !Object.hasOwn(PERMISSION_PROFILES, permissions)) {
    return { error: "Permissions must be default, plan or edit." };
  }
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
      permissions,
      after: typeof raw.after === "string" && raw.after.trim() ? raw.after.trim() : null,
      raw,
    },
  };
}

/** A new job file's text. */
export function jobText({ title, prompt, repo, agents, priority, pr = "off", permissions = "default", after = null }) {
  return JSON.stringify({
    about: title, prompt, where: { worktree: { repo } }, agents, priority, launch: "approve", pr,
    ...(permissions !== "default" ? { permissions } : {}),
    ...(after ? { after } : {}),
  }, null, 2) + "\n";
}

/** A file name for a new job: its title as a slug plus the time. */
export function jobId(title, now = Date.now()) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";
  return `${slug}-${now.toString(36)}`;
}

const byPriority = (a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** The saved allocation is stored under "approval" and applies to one version of the file. */
export function allocationFor(job, state) {
  const allocation = state.jobs?.[job.id]?.approval;
  return allocation?.route && allocation.hash === job.hash ? allocation : null;
}

/** A job stays in the same queue until the current version launches. */
export function classify(jobs, state) {
  const queued = [], launched = [];
  for (const job of jobs) {
    const s = state.jobs?.[job.id] ?? {};
    if (allocationFor(job, state) && s.launched?.hash === job.hash) launched.push(job);
    else queued.push(job);
  }
  const launchedAt = (j) => state.jobs?.[j.id]?.launched?.at ?? 0;
  return {
    queued: queued.sort(byPriority),
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
export function routeStatus(catalog, route, pools, judged, permissions = "default") {
  const agent = agentOf(catalog, route?.agent);
  if (agent && !supportsPermissions(agent, permissions)) {
    const label = PERMISSION_PROFILES[permissions]?.label ?? permissions;
    return { agent, pool: null, judgement: { light: "red", reason: `${agent.name} does not support the ${label} permission profile` } };
  }
  const pool = agent ? poolFor(agent, route.model, pools) : null;
  const judgement = pool ? judged[pool.id] : null;
  return { agent, pool, judgement: judgement ?? { light: "red", reason: "No allowance reading for this model" } };
}

/**
 * The proposal to show from an estimate: the route with the greenest, most urgent pool;
 * ties go to the estimator's recommendation.
 */
export function proposeRoute(catalog, estimate, pools, judged, permissions = "default") {
  if (!estimate?.routes?.length) return null;
  const rank = { green: 2, yellow: 1, red: 0 };
  const recommended = (r) => Number(r.agent === estimate.recommended);
  const scored = estimate.routes
    .filter((route) => supportsPermissions(agentOf(catalog, route.agent), permissions))
    .map((route) => ({ route, j: routeStatus(catalog, route, pools, judged, permissions).judgement }));
  scored.sort((a, b) => rank[b.j.light] - rank[a.j.light] || (b.j.urgency ?? 0) - (a.j.urgency ?? 0)
    || recommended(b.route) - recommended(a.route) || (b.j.headroom ?? 0) - (a.j.headroom ?? 0));
  return scored.length ? { ...scored[0].route } : null;
}

export const SETTLE_MS = 10 * 60_000;

/**
 * Pools something launched or resumed on within `settleMs`: readings lag use, so the next launch
 * there waits. A run's hold ends early once it has finished and its pool has a reading taken
 * after that (judged[pool].readAt), since that reading already shows what it used.
 */
export function settlingPools(state, judged = {}, now = Date.now(), settleMs = SETTLE_MS) {
  return new Set(Object.values(state.jobs ?? {})
    .filter((entry) => {
      const run = entry.launched;
      if (!run?.pool || now - Math.max(run.at, run.resumedAt ?? 0) >= settleMs) return false;
      const done = finishedAt(entry);
      const readAt = judged[run.pool]?.readAt;
      return !(done && Number.isFinite(readAt) && readAt > done);
    })
    .map((entry) => entry.launched.pool));
}

/**
 * Scheduled jobs ("launch when there's allowance") to launch now: approved, not launched, their
 * route's light not red; by priority, at most one per pool, and none on a pool something launched
 * on within `settleMs` (readings lag use). Nothing while paused.
 */
export function dueToLaunch(jobs, state, catalog, pools, judged, now = Date.now(), settleMs = SETTLE_MS) {
  if (state.paused) return [];
  const settling = settlingPools(state, judged, now, settleMs);
  const due = [];
  for (const job of classify(jobs, state).queued) {
    const allocation = allocationFor(job, state);
    if (!allocation?.auto || blockedBy(job, jobs, state)) continue;
    const { pool, judgement } = routeStatus(catalog, allocation.route, pools, judged, job.permissions);
    if (!pool || judgement.light === "red" || settling.has(pool.id)) continue;
    settling.add(pool.id);
    due.push(job);
  }
  return due;
}

// --- Braking running jobs ---

export function canBrake(entry) {
  const run = entry?.launched;
  return Boolean(run?.pool && !run.takenOver && run.pr?.phase !== "merged" && (!run.finishedAt || run.braked));
}

/** A plan for one reading. Status null means the agent is gone. Undefined means its identity or
 *  status hasn't been established. Resume decisions share the same settle period as Auto. */
export function brakeSteps(jobs, state, judged, agentStatus, now = Date.now(), settleMs = SETTLE_MS) {
  const settling = settlingPools(state, judged, now, settleMs);
  const steps = [];
  const resumes = [];
  for (const job of [...jobs].sort(byPriority)) {
    const entry = state.jobs?.[job.id];
    if (!canBrake(entry)) continue;
    const run = entry.launched;
    const status = agentStatus[job.id];
    const reading = judged[run.pool];
    const reason = reading?.reason ?? "No allowance reading";
    const brake = run.braked;
    if (!brake) {
      if (!run.noBrake && status === "working" && (!reading || reading.headroom <= 0)) {
        steps.push({ job, step: "brake", reason });
      }
      continue;
    }
    if (status === "working") {
      if (brake.stopped || run.noBrake) steps.push({ job, step: "taken-over" });
      else if (brake.attempts < 2) steps.push({ job, step: "retry", reason: brake.reason });
      continue;
    }
    const idle = status === "idle" || status === "done";
    if (!state.paused && !settling.has(run.pool) && (run.noBrake || (reading && reading.light !== "red"))
      && (idle || (status === null && run.hash === job.hash))) {
      settling.add(run.pool);
      resumes.push({ job, step: idle ? "resume" : "restart" });
    } else if (!brake.stopped && (idle || status === "blocked")) {
      steps.push({ job, step: "observed-stop" });
    }
  }
  return [...steps, ...resumes];
}

// --- Waiting for another job ---

/** Whether a launched job is finished: you marked it so, its PR merged, or (without a PR) its
 *  agent did its work and stopped. */
export function isFinished(entry) {
  const launched = entry?.launched;
  if (!launched) return false;
  if (launched.markedFinishedAt) return true;
  if (launched.pr && launched.pr.mode !== "off") return launched.pr.phase === "merged";
  return Boolean(launched.finishedAt && !launched.braked);
}

/** When a finished job finished (ms), or null if it isn't, or the time wasn't recorded. */
export function finishedAt(entry) {
  if (!isFinished(entry)) return null;
  const launched = entry.launched;
  const at = launched.markedFinishedAt ?? (launched.pr && launched.pr.mode !== "off" ? launched.pr.changedAt : launched.finishedAt);
  return Number.isFinite(at) ? at : null;
}

export function waitFor(job, state) {
  const allocation = allocationFor(job, state);
  return allocation?.after === undefined ? job.after : allocation.after;
}

/** The job this one waits for, if it isn't finished:
 *  { job, why }. A job that's gone doesn't hold anything up. */
export function blockedBy(job, jobs, state, after = waitFor(job, state)) {
  if (!after || after === job.id) return null;
  const first = jobs.find((j) => j.id === after);
  if (!first) return null;
  const entry = state.jobs?.[after];
  if (isFinished(entry)) return null;
  const w = entry?.launched?.pr;
  const why = !entry?.launched ? "isn't launched yet"
    : entry.launched.braked ? "is braked"
    : w && w.mode !== "off"
      ? w.phase === "needs-you" || w.phase === "closed" || w.phase === "ended" ? `stopped (${w.phase === "needs-you" ? "it needs you" : w.phase})` : "hasn't had its PR merged yet"
      : "is still working";
  return { job: first, why };
}

/** Jobs this one can wait for: not finished, not itself, and not waiting on it (directly or
 *  further down), so there's no loop. */
export function canWaitFor(job, jobs, state) {
  const after = (id) => {
    const candidate = jobs.find((j) => j.id === id);
    return candidate ? waitFor(candidate, state) : null;
  };
  const waitsOn = (id, target, seen = new Set()) => {
    for (let next = after(id); next && !seen.has(next); next = after(next)) {
      if (next === target) return true;
      seen.add(next);
    }
    return false;
  };
  return jobs.filter((j) => j.id !== job.id && !isFinished(state.jobs?.[j.id]) && !waitsOn(j.id, job.id));
}

/** A starting point for choosing by hand: the agent's mid-tier model (else its first) at medium
 *  effort (else its second level). */
export function defaultRoute(catalog, agentId) {
  const agent = agentOf(catalog, agentId);
  if (!agent?.models.length) return null;
  const model = agent.models.find((m) => m.tier === "mid") ?? agent.models[0];
  const effort = agent.efforts.includes("medium") ? "medium" : agent.efforts[Math.min(1, agent.efforts.length - 1)];
  return { agent: agent.id, model: model.id, effort, size: "m", why: "" };
}

/**
 * The routes to choose from: the estimate's, plus a default for each of the job's agents it left
 * out, so any agent can be picked by hand. Without an estimate, a default for each agent.
 */
export function routeOptions(catalog, job, estimate) {
  const routes = [...(estimate?.routes ?? [])];
  for (const id of job.agents) {
    if (routes.some((r) => r.agent === id)) continue;
    const r = defaultRoute(catalog, id);
    if (r) routes.push(r);
  }
  return routes;
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
