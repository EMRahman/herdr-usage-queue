// Usage Queue: queue agent jobs and launch them on whichever subscription has allowance to spare.
//
// Three views of one mod:
// - the sidebar block (no props): launch queue and recent launches, with a light per agent;
// - the job dialog ({ dialog: "job", id }): set or estimate the allocation and launch;
// - the add dialog ({ dialog: "add" }): a new job file;
// - the dependency map ({ dialog: "map" }): every job, each beside the one it waits for.
//
// Data lives at module scope, shared by every copy; a change bumps a shared revision so every
// copy redraws. Slow work (estimates, launches) runs in the sidebar copy, so closing a dialog
// doesn't cancel it.

import { Background, PathBuilder, View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  agents, checking, closeOverlay, exec, focused, knownAgents, notify, openOverlay, panes, pickFolder, props, run,
  setShared, settings, shared, spaces, terminals, theme, watchFolder,
} from "herdr";
import { agentOf, estimatorEffort, launchArgv, mergeCatalog, modelOf, PERMISSION_PROFILES } from "./catalog.js";
import { cleanUpMerged, cleanupEntry } from "./cleanup.js";
import { SIZES, SIZE_TEXT } from "./estimate.js";
import { dependencyMap } from "./graph.js";
import { fetchPR, findPR, mergePR, myLogin, prHead, prState } from "./github.js";
import { buildEstimatePrompt, jobTask, launchJob, runEstimate } from "./launch.js";
import { MAX_ROUNDS, reviewStep, roundMessage, sendArgs } from "./review.js";
import {
  agentLights, allocationFor, blockedBy, brakeSteps, canBrake, canWaitFor, classify, dueToLaunch, estimatorChoices,
  finishedAt, isFinished, jobId, newestFirst, jobText, pinnedRoute, proposeRoute, routeOptions, routeStatus, settlingPools, waitFor,
} from "./queue.js";
import { activeRepos, mainCheckout } from "./repos.js";
import { judgeAll } from "./rule.js";
import { suggestTitle, titleChoices } from "./title.js";
import {
  deleteJob, ensureFolders, expandHome, loadCatalog, loadDraft, loadJobs, loadState, paths, readPools, record, saveDraft,
  updateState, writeNewJob,
} from "./store.js";
import { ago, duration } from "./time.js";

const ID = "usage-queue";
const REVISION = `${ID}.revision`;
const POLL_MS = 60_000;
/** How often a PR (or the branch, before it has one) is checked on GitHub: on every 30 s tick.
 *  Just under 30 s, so a tick that fires a few ms early isn't skipped. */
const PR_POLL_MS = 25_000;
/** A PR watch with nothing happening for this long stops. */
const WATCH_FOR_MS = 24 * 3_600_000;
const PR_DONE = new Set(["merged", "closed", "needs-you", "ended"]);
/** A PR the queue stopped working on but that's still open: checked now and then for a merge,
 *  so a job waiting on it starts when you merge it yourself. */
const PR_LATE = new Set(["needs-you", "ended"]);
const LATE_POLL_MS = 60_000;
const LATE_FOR_MS = 12 * 3_600_000;
const PR_MODE_TEXT = { off: "No PR", review: "Open a PR", merge: "PR + merge on 👍" };
const BUSY_MS = 50_000;
/** How long after typing in the prompt stops the title is suggested again. */
const TITLE_AFTER_MS = 1_200;
/** Shorter prompts don't say enough to name. */
const TITLE_MIN_PROMPT = 12;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Fixed light colors, as Usage Monitor's: their meaning shouldn't depend on the theme.
const LIGHT = { green: "#2fbf71", yellow: "#d4a72c", red: "#e5534b" };
const LIGHT_WORD = { green: "Ready", yellow: "Open", red: "Not yet" };
const SIZE_LABEL = { s: "Small", m: "Medium", l: "Large" };

// --- Shared data ---

const data = {
  catalog: mergeCatalog(null),
  pools: [], judged: {}, readAt: 0, readError: "",
  state: { jobs: {} }, jobs: [], problems: [],
  loaded: false,
};
/** In-memory work running now, by job id. */
const running = {
  estimates: new Map(), allocations: new Set(), launches: new Map(), deletions: new Set(),
  brakes: new Map(), reviews: new Set(),
};
/** Each job's last estimate run, for the dialog. */
const lastRuns = new Map();
/** Work asked for by dialogs, run by a sidebar copy. */
const queue = [];
let workers = 0;
let reading = false;
let dispatching = false;
/** The add form as last typed: { title, titleManual, prompt, repo, agents, priority }, or null. undefined
 *  until read from draft.json. */
let draft = undefined;

function changed() {
  setShared(REVISION, ((shared(REVISION) ?? 0) + 1) % 1_000_000);
}

async function reloadJobs() {
  const state = await loadState();
  const { jobs, problems } = await loadJobs(state);
  const fresh = jobs.filter((j) => !state.jobs[j.id]?.createdAt);
  if (fresh.length) {
    const now = Date.now();
    data.state = await updateState((s) => {
      for (const j of fresh) s.jobs[j.id] = { ...(s.jobs[j.id] ?? {}), createdAt: now };
    });
  } else {
    data.state = state;
  }
  Object.assign(data, { jobs, problems, loaded: true });
  changed();
}

async function refreshReadings() {
  if (reading) return;
  reading = true;
  try {
    data.catalog = await loadCatalog();
    data.pools = await readPools(hasScheduled() || hasRunning());
    data.readAt = Date.now();
    data.readError = "";
  } catch (e) {
    data.readError = String(e?.message ?? e);
  } finally {
    reading = false;
  }
  data.judged = judgeAll(data.pools);
  changed();
}

/** Queued jobs set to launch by themselves when there's allowance. */
const hasScheduled = () => classify(data.jobs, data.state).queued.some((job) => allocationFor(job, data.state)?.auto);
const hasRunning = () => data.jobs.some((job) => {
  const entry = jobState(job.id);
  const launched = entry.launched;
  if (launched?.pool && launched.pr && !PR_DONE.has(launched.pr.phase)) return true;
  if (!canBrake(entry) || (launched.noBrake && !launched.braked)) return false;
  const { status } = jobAgent(launched);
  return launched.braked || status === "working" || status === "blocked"
    || Date.now() - launched.at < POLL_MS;
});

/** Brakes active jobs first, then gives jobs resuming and new Auto launches the shared pool slots. */
async function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    await refreshReadings();
    await applyBrakes();
    for (const job of dueToLaunch(data.jobs, data.state, data.catalog, data.pools, data.judged)) {
      await doLaunch({ id: job.id, hash: job.hash, auto: true });
    }
  } finally {
    dispatching = false;
  }
}

const jobById = (id) => data.jobs.find((j) => j.id === id) ?? null;
const jobState = (id) => data.state.jobs?.[id] ?? {};
const currentVersion = (job, entry) => entry?.hash === job.hash ? entry : null;
const lights = () => agentLights(data.catalog, data.pools, data.judged);
const lightLines = () => lights().map((l) => `${l.agent.id}: ${l.judgement.light} (${l.judgement.reason})`);
const jobRouteStatus = (job, route) => routeStatus(data.catalog, route, data.pools, data.judged, job.permissions);

/** The light to show beside a job: its saved or proposed route's, else its agents' best. */
function jobLight(job) {
  const s = jobState(job.id);
  const route = allocationFor(job, data.state)?.route
    ?? (currentVersion(job, s.estimate) ? s.proposal : null)
    ?? pinnedRoute(data.catalog, job);
  if (route) return jobRouteStatus(job, route).judgement;
  const own = lights().filter((l) => job.agents.includes(l.agent.id)).map((l) => l.judgement);
  const rank = { green: 2, yellow: 1, red: 0 };
  return own.sort((a, b) => rank[b.light] - rank[a.light])[0] ?? { light: "red", reason: "None of this job's agents has a reading" };
}

// --- Work: estimates and launches ---

async function doEstimate({ id, hash, agentId, modelId }) {
  const job = jobById(id);
  const agent = agentOf(data.catalog, agentId);
  const model = modelOf(agent, modelId);
  if (!job || job.hash !== hash || !agent || !model || running.estimates.has(id)) return;
  const effort = estimatorEffort(agent);
  running.estimates.set(id, { hash, label: `${agent.name} ${model.label}`, startedAt: Date.now(), error: "" });
  changed();
  const by = { agent: agent.id, model: model.id, effort, label: `${agent.name} ${model.label}` };
  await record({ type: "estimate-started", job: id, by });
  let prompt = "";
  try {
    prompt = await buildEstimatePrompt(job, data.catalog, lightLines());
    lastRuns.set(id, { hash, by, prompt, reply: "", log: null });
    changed();
    const { estimate, reply, log } = await runEstimate({ job, catalog: data.catalog, agent, model: model.id, effort, prompt });
    lastRuns.set(id, { hash, by, prompt, reply, log });
    const proposal = proposeRoute(data.catalog, estimate, data.pools, data.judged, job.permissions);
    data.state = await updateState((s) => {
      s.jobs[id] = {
        ...(s.jobs[id] ?? {}),
        estimate: { at: Date.now(), hash: job.hash, by: { agent: agent.id, model: model.id, effort }, ...estimate },
        proposal,
      };
    });
    await record({ type: "estimated", job: id, estimate, proposal, log });
    running.estimates.delete(id);
  } catch (e) {
    const error = String(e?.message ?? e);
    running.estimates.set(id, { ...running.estimates.get(id), error, failed: true });
    lastRuns.set(id, { hash, by, prompt, reply: e?.reply ?? "", stderr: e?.stderr ?? "", log: e?.log ?? null });
    await record({ type: "estimate-failed", job: id, error, log: e?.log ?? null });
  }
  changed();
}

async function doLaunch({ id, hash, auto = false }) {
  const job = jobById(id);
  if (!job || job.hash !== hash || running.launches.has(id) || running.allocations.has(id) || running.deletions.has(id)) return;
  const allocation = allocationFor(job, data.state);
  if (!allocation || currentVersion(job, jobState(id).launched) || (auto && (!allocation.auto || data.state.paused))) return;
  const wait = blockedBy(job, data.jobs, data.state);
  if (wait) return notify({ title: `${job.title}: waiting`, body: `It waits for ${wait.job.title}, which ${wait.why}.`, level: "warning" });
  const { route } = allocation;
  const { agent, judgement, pool } = jobRouteStatus(job, route);
  if (!agent) return notify({ title: "Can't launch", body: `Unknown agent ${route.agent}.`, level: "error" });
  if (judgement.light === "red") {
    return notify({ title: `${job.title}: not yet`, body: judgement.reason, level: "warning" });
  }
  if (auto && (settlingPools(data.state, data.judged).has(pool.id) || poolBusy(pool.id))) return;
  running.launches.set(id, pool.id);
  changed();
  try {
    const prMode = allocation.pr ?? job.pr ?? "off";
    const launched = await launchJob({ job, agent, model: route.model, effort: route.effort, pr: prMode });
    const entry = { at: Date.now(), hash: job.hash, route, pool: pool.id, light: judgement.light, permissions: job.permissions, ...launched };
    if (prMode !== "off") {
      entry.pr = { mode: prMode, phase: "working", number: null, url: "", rounds: 0, handled: [], sentAt: 0, terminal: null, changedAt: Date.now() };
    }
    data.state = await updateState((st) => { st.jobs[id] = { ...(st.jobs[id] ?? {}), launched: entry }; });
    await record({ type: "launched", job: id, auto, route, pool: pool?.id ?? null, light: judgement.light, reason: judgement.reason, ...launched });
    notify({ title: `${auto ? "Allowance is back: launched" : "Launched"}: ${job.title}`, body: `${agent.name} · ${route.model} · ${route.effort} in ${launched.branch}, from ${baseText(launched.base)}`
      + (launched.base.note ? `\n${launched.base.note}` : ""), level: launched.base.note ? "warning" : "info" });
  } catch (e) {
    const error = String(e?.message ?? e);
    await record({ type: "launch-failed", job: id, route, error });
    notify({ title: `Couldn't launch ${job.title}`, body: error, level: "error" });
  } finally {
    running.launches.delete(id);
    changed();
  }
}

// --- After launch: the allowance brake ---

const within = (folder) => (cwd) => !!cwd && (cwd === folder || cwd.startsWith(`${folder}/`));
const poolBusy = (id) => [...running.launches.values(), ...running.brakes.values()].includes(id);

/** Find the job's own agent. Keep the terminal identity once known, and leave ambiguous panes alone. */
function jobAgent(launched) {
  const inFolder = within(launched.folder);
  const local = new Map(spaces().filter((sp) => !sp.machine).map((sp) => [sp.id, sp.folder]));
  const all = panes();
  const paneById = new Map(all.map((p) => [p.pane, p]));
  const candidates = agents().filter((a) => local.has(a.space) &&
    (local.get(a.space) === launched.folder || inFolder(paneById.get(a.pane)?.cwd)));
  const terminal = launched.terminal ?? launched.pr?.terminal;
  const agent = terminal ? candidates.find((a) => a.address === terminal) : candidates.length === 1 ? candidates[0] : null;
  if (agent) return { agent, status: agent.status };
  const starting = all.some((p) => p.terminal && p.program?.agent && inFolder(p.cwd) && !p.status);
  return { agent: null, status: candidates.length || starting ? undefined : null };
}

async function patchLaunch(id, launched, change) {
  data.state = await updateState((s) => {
    const current = s.jobs[id]?.launched;
    if (current && current.at === launched.at && current.branch === launched.branch) change(current);
  });
  changed();
}

const hcError = (result) => {
  try {
    const message = JSON.parse(result.stderr)?.error?.message;
    if (message) return message;
  } catch {}
  return (result.stderr || result.stdout).trim().split("\n").at(-1) || `exit ${result.code}`;
};

async function interruptJob(job, launched, agent, step, reason) {
  const initial = step === "brake";
  const braked = initial ? { at: Date.now(), reason, pool: launched.pool, attempts: 1 }
    : { ...launched.braked, attempts: launched.braked.attempts + 1 };
  // Persist the brake before interrupting: the idle notification can arrive during hc interrupt.
  await patchLaunch(job.id, launched, (run) => { run.braked = braked; run.terminal = agent.address; });
  if (initial) await record({ type: "braked", job: job.id, ...braked });
  let outcome = "stopped", error;
  const current = jobState(job.id).launched;
  const live = jobAgent(launched);
  if (live.status === "working" && live.agent.address === agent.address && current?.at === launched.at &&
    current.braked && !current.noBrake && canBrake(jobState(job.id))) {
    try {
      const result = await exec("hc", ["interrupt", agent.address, "--json"], { timeout: 15_000 });
      if (result.code !== 0) throw new Error(hcError(result));
      outcome = JSON.parse(result.stdout).outcome;
      if (outcome !== "stopped" && outcome !== "exited") error = `hc interrupt reported ${outcome}.`;
    } catch (e) {
      error = String(e?.message ?? e);
    }
  }
  const stopped = !error && outcome === "stopped";
  await patchLaunch(job.id, launched, (run) => {
    if (run.braked) Object.assign(run.braked, { stopped, error });
  });
  if (initial) {
    const until = whenOpen(data.judged[launched.pool] ?? {});
    const pool = data.pools.find((p) => p.id === launched.pool)?.name ?? launched.pool;
    notify({ title: `${error ? "Braking" : "Braked"}: ${job.title}`,
      body: `${pool} · ${reason}.${until ? ` Resumes when allowance is back (reset ${until}).` : ""}`, level: "warning" });
  }
  if (error && braked.attempts >= 2) {
    await record({ type: "brake-failed", job: job.id, error });
    notify({ title: `Couldn't stop ${job.title}`, body: `${error} You can stop the agent in its pane.`, level: "error" });
  }
}

/** A replacement uses the exact argv of the last launch, including its permission flags. */
function restartAgent(launched, task) {
  const route = launched.route;
  const argv = launched.argv ?? launchArgv(agentOf(data.catalog, route.agent), route.model, route.effort, launched.permissions);
  run("space.new", { folder: launched.folder, argv, focus: false, task });
}

async function resumeJob(job, launched, agent) {
  const restart = !agent;
  if (restart) {
    const branch = await gitIn(launched.folder, ["branch", "--show-current"]);
    if (!branch.ok || branch.out !== launched.branch) throw new Error("The job's worktree or branch is no longer available.");
  }
  const entry = jobState(job.id);
  const live = jobAgent(launched);
  const reading = data.judged[launched.pool];
  if (!entry.launched?.braked || entry.launched.at !== launched.at || !canBrake(entry) || data.state.paused ||
    (!entry.launched.noBrake && (!reading || reading.light === "red"))) return;
  if (restart) {
    if (live.status !== null || jobById(job.id)?.hash !== launched.hash) return;
    const task = `Earlier work on this job is in this worktree (branch ${launched.branch}): check git status and git log first.\n\n`;
    restartAgent(launched, task + jobTask(job, launched, launched.pr?.mode ?? "off"));
  } else {
    if (!live.agent || live.agent.address !== agent.address || !["idle", "done"].includes(live.status)) return;
    const message = entry.launched.noBrake ? "Carry on where you left off." : "The allowance is back. Carry on where you left off.";
    const result = await exec("hc", sendArgs(agent.address, live.status, message), { timeout: 75_000 });
    if (result.code !== 0) throw new Error(hcError(result));
  }
  const now = Date.now();
  await patchLaunch(job.id, launched, (run) => {
    delete run.braked;
    delete run.finishedAt;
    run.resumedAt = now;
    run.worked = !restart;
    if (restart) delete run.terminal;
    if (run.pr) Object.assign(run.pr, { terminal: restart ? null : agent.address, changedAt: now, idleNoted: false, worked: false });
  });
  await record({ type: "resumed", job: job.id, pool: launched.pool, restarted: restart });
}

async function applyBrakes() {
  const statuses = Object.fromEntries(data.jobs.filter((job) => canBrake(jobState(job.id)))
    .map((job) => [job.id, jobAgent(jobState(job.id).launched).status]));
  for (const { job } of brakeSteps(data.jobs, data.state, data.judged, statuses)) {
    const launched = jobState(job.id).launched;
    if (!launched || running.reviews.has(job.id) || running.deletions.has(job.id) || running.allocations.has(job.id)) continue;
    const { agent, status } = jobAgent(launched);
    const [action] = brakeSteps([job], data.state, data.judged, { [job.id]: status });
    if (!action) continue;
    const { step, reason } = action;
    if ((step === "resume" || step === "restart") && poolBusy(launched.pool)) continue;
    running.brakes.set(job.id, launched.pool);
    try {
      if (step === "brake" || step === "retry") await interruptJob(job, launched, agent, step, reason);
      else if (step === "resume" || step === "restart") await resumeJob(job, launched, agent);
      else if (step === "observed-stop") await patchLaunch(job.id, launched, (run) => {
        if (run.braked) run.braked.stopped = true;
      });
      else if (step === "taken-over") {
        await patchLaunch(job.id, launched, (run) => {
          delete run.braked;
          delete run.finishedAt;
          run.takenOver = true;
          if (run.pr) run.pr.changedAt = Date.now();
        });
        await record({ type: "taken-over", job: job.id, pool: launched.pool });
      }
    } catch (e) {
      const error = String(e?.message ?? e);
      if (error !== launched.braked?.error) {
        await patchLaunch(job.id, launched, (run) => { if (run.braked) run.braked.error = error; });
        notify({ title: `Couldn't ${step} ${job.title}`, body: error, level: "error" });
      }
    } finally {
      running.brakes.delete(job.id);
    }
  }
}

async function letFinish(job, launched) {
  await patchLaunch(job.id, launched, (run) => { run.noBrake = true; });
  await record({ type: "no-brake", job: job.id });
}

// --- After launch: the PR and its review rounds ---

const polledAt = new Map();

async function patchWatch(id, changes) {
  data.state = await updateState((s) => {
    const w = s.jobs[id]?.launched?.pr;
    if (w) Object.assign(w, changes);
  });
  changed();
}

/** The space a launched job's agent runs in (its worktree folder), or null once it's gone. */
function agentSpace(job) {
  const folder = jobState(job.id).launched?.folder;
  if (!folder) return null;
  const all = panes();
  return spaces().find((sp) => sp.folder === folder
    || sp.tabs?.some((tab) => all.some((p) => p.tab === tab.id && p.cwd?.startsWith(folder)))) ?? null;
}

const canSendRound = (launched) => launched && !launched.braked &&
  (!launched.resumedAt || Date.now() - launched.resumedAt >= 30_000) &&
  (launched.noBrake || !launched.pool || (data.judged[launched.pool] && data.judged[launched.pool].light !== "red"));

/** Hands a review round to the job's agent, or to a new one in its worktree if it's gone.
 *  Returns "" when it went, else why it didn't. */
async function sendRound(launched, agent, message) {
  if (agent) {
    const r = await exec("hc", sendArgs(agent.address, agent.status, message), { timeout: 75_000 });
    if (r.code === 0) return "";
    return `hc send to ${agent.address} (${agent.status}) failed: ${hcError(r)}`;
  }
  restartAgent(launched, `You're continuing work on this branch (${launched.branch}), which has an open pull request.\n\n${message}`);
  return "";
}

/** Checks every launched job that's waiting for its PR or under review, and takes the next step. */
async function watchPRs() {
  const now = Date.now();
  for (const job of data.jobs) {
    if (running.brakes.has(job.id) || running.reviews.has(job.id)) continue;
    const launched = jobState(job.id).launched;
    if (launched && !launched.pr) await trackFinish(job.id, launched);
    const w = launched?.pr;
    if (w && PR_LATE.has(w.phase)) await lateCheck(job, launched, w, now);
    if (!w || PR_DONE.has(w.phase)) continue;
    const id = job.id;
    const { agent, status } = jobAgent(launched);
    if (agent && agent.address !== w.terminal) await patchWatch(id, { terminal: agent.address });
    if (status === "working" && !w.worked) await patchWatch(id, { worked: true });
    if (now - (polledAt.get(id) ?? 0) < PR_POLL_MS) continue;
    polledAt.set(id, now);
    if (!jobState(id).launched?.braked && now - (w.changedAt ?? launched.at) > WATCH_FOR_MS) {
      await patchWatch(id, { phase: "ended" });
      notify({ title: `Stopped watching: ${job.title}`, body: "Nothing happened for a day.", level: "info" });
      continue;
    }
    const idle = status === null || status === "idle" || status === "done";
    let sending = false;
    try {
      if (!w.number) {
        const found = await findPR(launched.folder, launched.branch);
        if (found) {
          await patchWatch(id, { number: found.number, url: found.url, phase: "in-review", changedAt: now });
          await record({ type: "pr-opened", job: id, number: found.number, url: found.url });
          notify({ title: `PR #${found.number} opened: ${job.title}`, body: "Watching it for reviews.", level: "info" });
        } else if (w.worked && agent && idle && !w.idleNoted && !running.brakes.has(id) && !jobState(id).launched?.braked) {
          await patchWatch(id, { idleNoted: true });
          notify({ title: `${job.title}: no PR yet`, body: "The agent stopped without opening one. It may be asking you something.", level: "warning" });
        }
        continue;
      }
      const pr = await fetchPR(launched.folder, w.number);
      // GitHub answered: an earlier failure to reach it is over (a failed send clears on its own).
      if (w.error && !w.sendFailed) await patchWatch(id, { error: undefined });
      const me = await myLogin(launched.folder);
      const current = jobState(id).launched;
      if (!current || current.at !== launched.at || !current.pr || PR_DONE.has(current.pr.phase)) continue;
      const step = reviewStep(pr, current.pr, me, idle && canSendRound(current), Boolean(current.braked || running.brakes.has(id)));
      if (step.action === "merged" || step.action === "closed") {
        await patchWatch(id, { phase: step.action, changedAt: now });
        await record({ type: `pr-${step.action}`, job: id, number: w.number });
        if (step.action === "merged") await queueCleanup(job, launched, w.number);
      } else if (step.action === "merge") {
        try {
          const how = await mergePR(launched.folder, w.number);
          await patchWatch(id, { phase: "merged", changedAt: now });
          await record({ type: "pr-merged", job: id, number: w.number, how, by: "queue" });
          await queueCleanup(job, launched, w.number);
          notify({ title: `Merged PR #${w.number}: ${job.title}`, body: `It got a 👍 (${how}).`, level: "info" });
        } catch (e) {
          await patchWatch(id, { phase: "needs-you", error: String(e?.message ?? e), changedAt: now });
          notify({ title: `Couldn't merge PR #${w.number}`, body: String(e?.message ?? e), level: "error" });
        }
      } else if (step.action === "approved") {
        // Still watched after this, until you merge it: a job may be waiting on it.
        if (w.phase === "approved") continue;
        await patchWatch(id, { phase: "approved", changedAt: now });
        await record({ type: "pr-approved", job: id, number: w.number });
        notify({ title: `👍 on PR #${w.number}: ${job.title}`, body: "Ready for you to merge.", level: "info" });
      } else if (step.action === "needs-you") {
        await patchWatch(id, { phase: "needs-you", changedAt: now });
        await record({ type: "pr-needs-you", job: id, number: w.number });
        notify({ title: `PR #${w.number} needs you: ${job.title}`, body: `${MAX_ROUNDS} review rounds are done and there are new comments.`, level: "warning" });
      } else if (step.action === "address") {
        const live = jobAgent(current);
        if (running.reviews.has(id) || running.brakes.has(id) || !canSendRound(current) ||
          (live.status !== null && live.status !== "idle" && live.status !== "done")) continue;
        const round = (w.rounds ?? 0) + 1;
        const message = roundMessage({ round, number: w.number, url: w.url, branch: launched.branch, items: step.items, mode: w.mode });
        running.reviews.add(id);
        sending = true;
        const failed = await sendRound(current, live.agent, message);
        if (!failed) {
          await patchWatch(id, {
            rounds: round, sentAt: now, changedAt: now, handled: [...(w.handled ?? []), ...step.items.map((x) => x.id)],
            terminal: live.agent?.address ?? null, error: undefined, sendFailed: undefined,
          });
          if (!live.agent) await patchLaunch(id, current, (run) => { delete run.terminal; });
          await record({ type: "pr-round", job: id, number: w.number, round, comments: step.items.length });
          notify({ title: `Review round ${round}/${MAX_ROUNDS}: ${job.title}`, body: `${step.items.length} comment(s) sent to the agent.`, level: "info" });
        } else {
          // Tried again on the next poll; you hear about it once, not every 30 seconds.
          await patchWatch(id, { error: failed, sendFailed: true });
          if (!w.sendFailed) {
            await record({ type: "pr-round-failed", job: id, number: w.number, round, error: failed });
            notify({ title: `Couldn't send review round ${round}: ${job.title}`, body: `${failed}\nIt tries again every 30 seconds.`, level: "warning" });
          }
        }
      }
    } catch (e) {
      await patchWatch(id, { error: String(e?.message ?? e) });
    } finally {
      if (sending) running.reviews.delete(id);
    }
  }
}

/** A PR the queue stopped working on: merged or closed since, by you? */
async function lateCheck(job, launched, w, now) {
  if (!w.number || now - (w.changedAt ?? launched.at) > LATE_FOR_MS) return;
  if (now - (polledAt.get(job.id) ?? 0) < LATE_POLL_MS) return;
  polledAt.set(job.id, now);
  try {
    const state = await prState(launched.folder, w.number);
    if (state === "OPEN") return;
    const phase = state === "MERGED" ? "merged" : "closed";
    await patchWatch(job.id, { phase, changedAt: now, error: undefined, sendFailed: undefined });
    await record({ type: `pr-${phase}`, job: job.id, number: w.number, late: true });
    if (phase === "merged") {
      await queueCleanup(job, launched, w.number);
      const waiting = data.jobs.filter((j) => waitFor(j, data.state) === job.id && !currentVersion(j, jobState(j.id).launched));
      if (waiting.length) notify({ title: `PR #${w.number} merged: ${job.title}`, body: `${waiting.map((j) => j.title).join(", ")} can launch now.`, level: "info" });
    }
  } catch {}
}

// --- After a merge: the job's worktree and branches (see cleanup.js) ---

/** A merged job's leftovers are retried this often while they have to wait. */
const CLEANUP_RETRY_MS = 2 * 60_000;
/** After this long, a cleanup that still has to wait is given up (and you're told). */
const CLEANUP_FOR_MS = 7 * 24 * 3_600_000;
const CLOSING = "Closing its space first.";
const cleanupTriedAt = new Map();
/** Terminals of spaces closed for a cleanup, by worktree folder: it waits until they stop. */
const closingTerminals = new Map();
let cleaning = false;

/** Queues a merged job's worktree and branches for removal. They're kept in state apart from
 *  the job, so deleting the job doesn't leave them behind. */
async function queueCleanup(job, launched, number) {
  if (!launched?.branch || !number || launched.cleanupQueued) return;
  try {
    data.state = await updateState((s) => {
      s.cleanups ??= {};
      s.cleanups[launched.branch] ??= cleanupEntry(job, launched, number);
      if (s.jobs[job.id]?.launched) s.jobs[job.id].launched.cleanupQueued = true;
    });
    changed();
  } catch {
    // Not queued: runCleanups queues merged jobs it finds without one.
  }
}

/** What's open in a worktree: { busy } says why it can't be closed now ("" if it can), and
 *  `spaces` are the job's own spaces there, safe to close. */
function folderUse(folder) {
  const inIt = within(folder);
  const all = panes();
  const cwdOf = new Map(all.map((p) => [p.pane, p.cwd]));
  const result = (busy, own = []) => ({ busy, spaces: own });
  if (agents().some((a) => inIt(cwdOf.get(a.pane)) && (a.status === "working" || a.status === "blocked"))) {
    return result("Its agent is still working.");
  }
  const stopping = closingTerminals.get(folder);
  if (stopping && terminals().some((t) => t.state === "live" && stopping.has(t.address))) {
    return result("Its terminals haven't stopped yet.");
  }
  closingTerminals.delete(folder);
  const own = [];
  for (const sp of spaces()) {
    const tabs = new Set((sp.tabs ?? []).map((tab) => tab.id));
    const mine = all.filter((p) => tabs.has(p.tab) && p.terminal);
    if (!inIt(sp.folder) && !mine.some((p) => inIt(p.cwd))) continue;
    // Only the job's own space is closed: one you opened elsewhere waits for you.
    if (!inIt(sp.folder)) return result(`A terminal in the ${sp.name} space is in it.`);
    if (mine.some((p) => !inIt(p.cwd))) return result(`The ${sp.name} space has terminals outside it.`);
    if (sp.active) return result("Its space is on screen.");
    own.push(sp);
  }
  return result("", own);
}

/** cleanUpMerged's freeFolder: closes the job's space, then waits for its terminals to stop. */
async function closeFolder(folder) {
  const use = folderUse(folder);
  if (use.busy || !use.spaces.length) return use.busy;
  const tabs = new Set(use.spaces.flatMap((sp) => (sp.tabs ?? []).map((tab) => tab.id)));
  closingTerminals.set(folder, new Set(panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => p.terminal)));
  for (const sp of use.spaces) run("space.close", { id: sp.id, confirmed: true });
  return CLOSING;
}

async function gitIn(cwd, args, timeout = 30_000) {
  const r = await exec("git", args, { cwd, timeout });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** Each folder's main checkout (or null), by folder: asked once per folder while the mod runs. */
const checkouts = new Map();
const checkoutOf = (folder) => {
  const path = expandHome(folder);
  if (!checkouts.has(path)) checkouts.set(path, mainCheckout(gitIn, path).catch(() => null));
  return checkouts.get(path);
};

/** Repos for the add dialog: the focused pane's, those open in spaces, then recent jobs'. */
function repoChoices(focusedFolder) {
  const open = [];
  for (const sp of spaces()) if (!sp.machine && sp.folder) open.push(sp.folder);
  for (const p of panes()) if (p.cwd) open.push(p.cwd);
  const recent = [...data.jobs]
    .sort((a, b) => (data.state.jobs[b.id]?.createdAt ?? 0) - (data.state.jobs[a.id]?.createdAt ?? 0))
    .map((j) => j.repo);
  return activeRepos([focusedFolder, ...open, ...recent].map(expandHome), checkoutOf);
}

/** Removes merged jobs' worktrees and branches when nothing would be lost (see cleanup.js). */
async function runCleanups() {
  if (cleaning) return;
  cleaning = true;
  try {
    // Merged before cleanups were queued: queue them now.
    for (const job of data.jobs) {
      const launched = jobState(job.id).launched;
      if (launched?.pr?.phase === "merged" && !launched.cleanupQueued) await queueCleanup(job, launched, launched.pr.number);
    }
    for (const entry of Object.values(data.state.cleanups ?? {})) {
      const now = Date.now();
      if (now - (cleanupTriedAt.get(entry.branch) ?? 0) < CLEANUP_RETRY_MS) continue;
      const late = now - entry.at > CLEANUP_FOR_MS;
      // While its agent works or its space is on screen, wait without asking GitHub.
      const busy = folderUse(entry.folder).busy;
      if (busy && !late) continue;
      cleanupTriedAt.set(entry.branch, now);
      let result;
      try {
        if (late) {
          result = { status: "kept", reason: `Gave up after a week of waiting${busy ? `: ${busy}` : "."}`, removed: [] };
        } else {
          const repo = expandHome(entry.repo);
          const head = await prHead(repo, entry.number);
          result = head.state && head.state !== "MERGED"
            ? { status: "kept", reason: `PR #${entry.number} is ${head.state.toLowerCase()} now.`, removed: [] }
            // Both the folder as launched (what its space uses; git may resolve links) and where git
            // says the worktree is now (`git worktree move`): the one removed must be free.
            : await cleanUpMerged({
              git: gitIn, repo, branch: entry.branch, number: entry.number, headOid: head.headRefOid,
              freeFolder: async (path) => (await closeFolder(entry.folder)) || (path !== entry.folder ? await closeFolder(path) : ""),
            });
        }
      } catch (e) {
        result = { status: "wait", reason: String(e?.message ?? e), removed: [] };
      }
      if (result.status === "wait") {
        // A space it just closed: look again on the next pass rather than in two minutes.
        if (result.reason === CLOSING) cleanupTriedAt.delete(entry.branch);
        continue;
      }
      closingTerminals.delete(entry.folder);
      data.state = await updateState((s) => { delete s.cleanups?.[entry.branch]; });
      await record({ type: "cleanup", job: entry.job, branch: entry.branch, number: entry.number, ...result });
      if (result.status === "kept") {
        notify({ title: `Kept ${entry.branch}`, body: `${entry.title}: ${result.reason}`, level: "warning" });
      }
      changed();
    }
  } finally {
    cleaning = false;
  }
}

/** Marks a launched job finished by hand (or takes that back), so jobs waiting on it can launch.
 *  Its PR, if any, is still watched as before. */
async function markFinished(job, on) {
  data.state = await updateState((s) => {
    const launched = s.jobs[job.id]?.launched;
    if (!launched) return;
    if (on) launched.markedFinishedAt = Date.now();
    else delete launched.markedFinishedAt;
  });
  await record({ type: on ? "marked-finished" : "unmarked-finished", job: job.id });
  changed();
}

/** A launched job without a PR is finished once its agent has worked and stopped (or is gone):
 *  that's what a job waiting on it waits for. */
async function trackFinish(id, launched) {
  const activeAt = launched.resumedAt ?? launched.at;
  if (launched.braked || launched.finishedAt || Date.now() - activeAt > WATCH_FOR_MS) return;
  const { agent, status } = jobAgent(launched);
  const changes = {};
  if (agent && agent.address !== launched.terminal) changes.terminal = agent.address;
  if ((status === "working" || status === "done") && !launched.worked) changes.worked = true;
  const worked = launched.worked || changes.worked;
  if (worked && (status === null || status === "idle" || status === "done") &&
    (!launched.resumedAt || Date.now() - launched.resumedAt >= 30_000)) changes.finishedAt = Date.now();
  if (!Object.keys(changes).length) return;
  await patchLaunch(id, launched, (run) => {
    if (!run.braked && run.resumedAt === launched.resumedAt) Object.assign(run, changes);
  });
  if (changes.finishedAt && changes.finishedAt === jobState(id).launched?.finishedAt) await record({ type: "finished", job: id });
}

/** A launched job's PR status, for its row: "PR #12 · round 1/3", "Merged", … */
function prStatus(w) {
  if (!w) return "";
  if (w.phase === "working") return "Working";
  if (w.phase === "merged") return `Merged #${w.number}`;
  if (w.phase === "closed") return `Closed #${w.number}`;
  if (w.phase === "approved") return `👍 #${w.number} · merge it`;
  if (w.phase === "needs-you") return `Needs you #${w.number}`;
  if (w.phase === "ended") return "Stopped watching";
  return `PR #${w.number}${w.rounds ? ` · round ${w.rounds}/${MAX_ROUNDS}` : ""}`;
}

async function setAfter(job, after) {
  data.state = await updateState((s) => {
    const allocation = allocationFor(job, s);
    if (allocation) allocation.after = after;
  });
  await record({ type: "wait-for", job: job.id, after });
  changed();
}

async function setPrMode(job, pr) {
  data.state = await updateState((s) => {
    const allocation = allocationFor(job, s);
    if (allocation) allocation.pr = pr;
  });
  changed();
}

/** Hands work to a sidebar copy, which outlives dialogs. Without one, runs it in this copy and
 *  returns false: the caller then has to stay open until it's done. */
function ask(work, cx) {
  if (workers > 0) {
    queue.push(work);
    changed();
    return true;
  }
  cx.spawn(async () => (work.type === "estimate" ? doEstimate(work) : doLaunch(work)));
  return false;
}

/** Loads data for a dialog opened without a sidebar copy to load it. */
function loadIfNeeded(cx) {
  if (data.loaded || checking()) return;
  cx.spawn(async (cx) => {
    await ensureFolders();
    await reloadJobs();
    await refreshReadings();
    cx.notify();
  });
}

async function saveAllocation(job, route, auto, pr, after) {
  data.state = await updateState((s) => {
    s.jobs[job.id] = { ...(s.jobs[job.id] ?? {}), approval: { at: Date.now(), hash: job.hash, route, auto, pr, after } };
  });
  await record({ type: "approved", job: job.id, route, auto, pr, after });
  changed();
}

/** Turns "launch when there's allowance" on or off for an allocated job. */
async function setAuto(job, auto) {
  data.state = await updateState((s) => {
    const allocation = allocationFor(job, s);
    if (allocation) allocation.auto = auto;
  });
  await record({ type: auto ? "scheduled" : "unscheduled", job: job.id });
  changed();
}

async function setPaused(paused) {
  data.state = await updateState((s) => { s.paused = paused; });
  await record({ type: paused ? "paused" : "resumed" });
  changed();
}

function requestLaunch(job, cx, auto = false) {
  return ask({ type: "launch", id: job.id, hash: job.hash, auto }, cx);
}

/** Starts the job now if eligible, or schedules it. Returns false if this view runs it. */
function autoLaunch(job, cx) {
  cx.spawn(async (cx) => {
    await setAuto(job, true);
    if (!dispatching && dueToLaunch(data.jobs, data.state, data.catalog, data.pools, data.judged).includes(job)) {
      requestLaunch(job, cx, true);
    }
  });
  return true;
}

/** When a red light should change, for people: "in 2h 10m", or "" when unknown. */
const whenOpen = (j) => (j.changesAt && j.changesAt > Date.now() ? `in ${duration(j.changesAt - Date.now())}` : "");

function brakeStatus(launched) {
  const { braked, noBrake, pool } = launched;
  if (!braked) return launched.takenOver ? "Taken over" : noBrake ? "Let it finish" : "";
  if (braked.error && braked.attempts >= 2 && !braked.stopped) return "Braked · couldn't stop";
  if (data.state.paused) return "Braked · Auto paused";
  const reading = data.judged[pool];
  if (noBrake || (reading && reading.light !== "red")) return "Braked · waiting to resume";
  if (!reading || reading.reading === "missing") return "Braked · no reading";
  if (reading.reading === "stale") return "Braked · stale reading";
  const when = whenOpen(reading);
  return when ? `Braked · resumes ${when}` : "Braked · at reserve";
}

async function clearAllocation(job) {
  const id = job.id;
  if (running.launches.has(id) || running.brakes.has(id) || running.allocations.has(id) || running.deletions.has(id)) return;
  running.allocations.add(id);
  changed();
  try {
    data.state = await updateState((s) => {
      if (!allocationFor(job, s)) return;
      delete s.jobs[id].approval;
      delete s.jobs[id].launched;
    });
    await record({ type: "unapproved", job: id });
  } finally {
    running.allocations.delete(id);
    changed();
  }
}

async function removeJob(id) {
  if (running.deletions.has(id) || running.allocations.has(id) || running.launches.has(id) || running.brakes.has(id)) return;
  running.deletions.add(id);
  try {
    await deleteJob(id);
    await record({ type: "deleted", job: id });
    await reloadJobs();
  } finally {
    running.deletions.delete(id);
  }
}

// --- Small pieces ---

const elapsed = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : duration(ms));

const dot = (light, size = 8) => div().size(size).flex_none().rounded(size).bg(LIGHT[light] ?? "#888888");

/** "Wait for": Nothing, or one of the jobs it can wait for, newest first so the oldest is the
 *  last chip (marked as such). pick(id or null, cx). */
function waitChips(t, after, options, pick) {
  const sorted = newestFirst(options);
  return h_flex().gap(6).flex_wrap().items_center()
    .child(chip(t, "after-none", "Nothing", !after, (_e, cx) => pick(null, cx)))
    .children(sorted.map((o) => chip(t, `after-${o.id}`, o.title, after === o.id, (_e, cx) => pick(o.id, cx), o.id)))
    .when(sorted.length > 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("← oldest")));
}

function button(t, id, text, style, action, disabled = false) {
  const primary = style === "primary";
  const bg = primary ? (disabled ? t.raised : t.solid) : t.raised;
  const fg = primary ? (disabled ? t.dim : t.solid_foreground) : style === "danger" ? t.ansi1 : disabled ? t.dim : t.foreground;
  return h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(7).border_1()
    .border_color(primary && !disabled ? t.solid : t.input).bg(bg).text_color(fg).text_size(12.5).font_medium()
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
    .when(disabled, (el) => el.cursor_not_allowed())
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) action(e, cx); })
    .child(text);
}

function chip(t, id, text, selected, action, tooltip = null) {
  return h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).border_1()
    .border_color(selected ? t.accent : t.input).bg(selected ? t.selected : t.background)
    .text_size(12).text_color(selected ? t.foreground : t.muted).cursor_pointer()
    .hover((s) => s.text_color(t.foreground))
    .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
    .on_click((e, cx) => action(e, cx))
    .child(text);
}

/** A small button on a sidebar row; `on` draws it highlighted (a scheduled Auto). */
function rowButton(t, id, text, enabled, tooltip, action, on = false) {
  return h_flex().id(id).h(22).px(7).flex_none().items_center().rounded(5).text_size(11.5).font_medium()
    .text_color(!enabled ? t.dim : on ? t.accent : t.foreground).bg(on ? t.selected : t.raised)
    .when(on, (el) => el.border_1().border_color(t.accent))
    .when(enabled, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)))
    .tooltip(tooltip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); })
    .child(text);
}

/** What a job's base means, before launch. */
const BASE_TEXT = (base) => base === "remote" ? "the remote's latest default branch (fetched)"
  : base === "local" ? "your checkout's HEAD" : `the latest ${base} (fetched)`;

/** Where a launched job started: "origin/main @ 1a2b3c4". */
const baseText = (base) => (base ? `${base.ref} @ ${String(base.commit).slice(0, 7)}` : "HEAD");

const routeText = (route) => {
  const agent = agentOf(data.catalog, route.agent);
  const model = modelOf(agent, route.model);
  return `${agent?.name ?? route.agent} · ${model?.label ?? route.model} · ${route.effort}`;
};

// --- The dependency map ---

/** Card size and spacing, px. */
const MAP = { w: 210, h: 48, colGap: 20, rowGap: 36, pad: 16, gutter: 104 };

const MAP_STAGES = {
  working: { word: "Working", color: (t) => t.working, tip: "Launched: its agent is at work or its PR is open." },
  waiting: { word: "Waiting", color: (t) => t.dim, tip: "Not launched yet: needs allocation, allowance, or the job it waits for." },
  done: { word: "Merged / done", color: () => LIGHT.green, tip: "Its PR is merged, its agent finished (no PR), or you marked it finished." },
};

/** Room the map dialog needs around the map itself: padding, title, legend, border, footer. */
const MAP_DIALOG = { w: 36 + 2 + 12, h: 36 + 20 + 20 + 24 + 12 + 2 + 42 + 12, minW: 600, minH: 280 };

/** Where the map's rows and columns go, and its size. Rows count up from the bottom: finished
 *  jobs low, jobs furthest from running on top. */
function mapGeometry(map) {
  const x = (col) => MAP.gutter + MAP.pad + col * (MAP.w + MAP.colGap);
  const y = (row) => MAP.pad + (map.rows - 1 - row) * (MAP.h + MAP.rowGap);
  return { x, y, width: x(map.cols) - MAP.colGap + MAP.pad, height: y(-1) - MAP.rowGap + MAP.pad };
}

/** A map card's second line: where the job is, and in what colour. */
function mapStatus(t, { job, stage }) {
  const s = jobState(job.id);
  if (stage === "done") {
    const w = s.launched.pr;
    const text = s.launched.markedFinishedAt ? "Marked finished"
      : w && w.mode !== "off" ? `Merged #${w.number ?? "?"}` : "Finished";
    const at = finishedAt(s);
    return { text: at ? `${text} · ${ago(at)}` : text, color: LIGHT.green };
  }
  if (stage === "working") {
    const brake = brakeStatus(s.launched);
    const w = s.launched.pr;
    if (brake) return { text: brake, color: LIGHT.yellow };
    if (w?.phase === "needs-you") return { text: prStatus(w), color: LIGHT.yellow };
    return { text: w ? prStatus(w) : `Working · ${ago(s.launched.at)}`, color: t.working };
  }
  const wait = blockedBy(job, data.jobs, data.state);
  const allocation = allocationFor(job, data.state);
  if (running.launches.has(job.id)) return { text: "Launching…", color: t.working };
  if (wait) return { text: `Waits for ${wait.job.title}`, color: t.dim };
  if (!allocation) return { text: "Needs allocation", color: t.dim };
  const j = jobLight(job);
  if (allocation.auto) {
    return { text: data.state.paused ? "Auto · paused" : j.light === "red" ? `Auto ${whenOpen(j)}`.trim() : "Auto now", color: t.accent };
  }
  return j.light === "red" ? { text: "Not yet · no allowance", color: t.dim } : { text: "Ready to launch", color: LIGHT[j.light] };
}

// --- The view ---

export default class UsageQueue extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.dialog === "add") return this.initAdd(cx);
    if (p.dialog === "job") return this.initJob(cx);
    if (p.dialog === "map") return loadIfNeeded(cx);

    if (checking()) return;
    workers++;
    this.worker = true;
    cx.spawn(async (cx) => {
      await ensureFolders();
      if (draft === undefined) draft = await loadDraft();
      await reloadJobs();
      // Job files written by you or an agent show up without a restart.
      cx.spawn(async () => {
        for (;;) {
          try { await watchFolder(paths().jobs); } catch { return; }
          await reloadJobs();
        }
      });
      await refreshReadings();
      cx.notify();
    });
    cx.timer.every(POLL_MS, (cx) => cx.spawn(dispatch));
    // Launched jobs' PRs: each is checked on GitHub every 30 seconds (see watchPRs).
    // Then merged jobs' worktrees and branches go (see runCleanups).
    cx.timer.every(30_000, (cx) => cx.spawn(async () => {
      await watchPRs();
      await runCleanups();
    }));
    // Dialogs hand their work here so that closing them doesn't cancel it.
    cx.timer.every(1000, (cx) => {
      while (queue.length) {
        const work = queue.shift();
        cx.spawn(async () => (work.type === "estimate" ? doEstimate(work) : doLaunch(work)));
      }
    });
  }

  async close() {
    if (this.worker) workers--;
    // The add form's last keystrokes may not be on disk yet.
    if (this.adding && draft !== undefined) await saveDraft(draft);
  }

  // ---------- Sidebar ----------

  openJob(id) {
    // A fixed share of the window: the middle scrolls, the title and buttons stay put.
    openOverlay({ mod: ID, kind: "dialog", width: 580, height: 0.85, props: { dialog: "job", id } });
  }

  /** The map dialog, as big as the map needs (at most 90% of the window), centered. */
  openMap() {
    const { width, height } = mapGeometry(dependencyMap(data.jobs, data.state));
    let w = Math.max(MAP_DIALOG.minW, width + MAP_DIALOG.w), h = Math.max(MAP_DIALOG.minH, height + MAP_DIALOG.h);
    try {
      const view = globalThis.window?.viewport_size?.();
      const zoom = Number(settings()?.zoom) || 1;
      if (view?.width && view?.height) {
        w = Math.min(w, (view.width / zoom) * 0.9);
        h = Math.min(h, (view.height / zoom) * 0.9);
      }
    } catch { /* no window size: the dialog's own scrollbars cope */ }
    openOverlay({ mod: ID, kind: "dialog", width: Math.round(w), height: Math.round(h), props: { dialog: "map" } });
  }

  openAdd() {
    openOverlay({ mod: ID, kind: "dialog", width: 560, height: 0.85, props: { dialog: "add" } });
  }

  lightsRow(t) {
    const list = lights();
    if (!list.length) {
      return div().px(16).pb(6).text_size(11.5).text_color(t.dim).truncate()
        .child(data.readError || (data.readAt ? "No coding agent readings" : "Reading allowance…"))
        .when(Boolean(data.readError), (el) => el.id("read-error").tooltip(data.readError));
    }
    return h_flex().id("lights").px(16).pb(6).gap(12).flex_none().items_center().flex_wrap().children(list.map((l) => {
      const tip = [
        `${l.agent.name}: ${LIGHT_WORD[l.judgement.light]}`,
        ...l.pools.map((p) => `${p.name}: ${data.judged[p.id]?.reason ?? ""}`),
        data.readError ? `\n${data.readError}` : "",
      ].filter(Boolean).join("\n");
      return h_flex().id(`light-${l.agent.id}`).gap(5).items_center().tooltip(tip)
        .child(dot(l.judgement.light))
        .child(div().text_size(11.5).text_color(t.muted).child(l.agent.name));
    }));
  }

  jobRow(t, job, kind, wait = null) {
    const s = jobState(job.id);
    const allocation = allocationFor(job, data.state);
    const j = kind === "launched" ? { light: s.launched?.light ?? "yellow", reason: "" } : jobLight(job);
    const waitText = wait ? `Waits for ${wait.job.title}, which ${wait.why}.` : "";
    let right = null;
    if (kind === "queued" && allocation) {
      const busy = running.launches.has(job.id) || running.allocations.has(job.id);
      const auto = allocation.auto;
      const red = j.light === "red";
      right = busy
        ? div().text_size(11.5).text_color(t.muted).frames(SPINNER, 90)
        : auto
          ? rowButton(t, `auto-${job.id}`, data.state.paused ? "Paused" : wait ? "Auto after" : `Auto ${red ? whenOpen(j) : "now"}`.trim(), true,
            `Launches by itself ${wait ? `once ${wait.job.title} is finished and ` : "when "}there's allowance${data.state.paused ? " (scheduled launches are paused)" : ""}.${wait ? ` ${waitText}` : ""} Now: ${j.reason}\nClick to cancel.`,
            (cx) => cx.spawn(async () => setAuto(job, false)), true)
          : h_flex().gap(4).flex_none()
            .child(rowButton(t, `auto-${job.id}`, "Auto", true, data.state.paused
              ? "Schedule this job for when Auto resumes."
              : wait
              ? `Launch by itself once ${wait.job.title} is finished and there's allowance. ${waitText}`
              : red ? `Launch by itself when there's allowance. Now: ${j.reason}`
                : `There's allowance now, so this launches now, like Launch (${LIGHT_WORD[j.light]}: ${j.reason}).`,
            (cx) => autoLaunch(job, cx)))
            .child(rowButton(t, `launch-${job.id}`, "Launch", !red && !wait,
              wait ? waitText : red ? `Not yet: ${j.reason}` : `Launch now (${LIGHT_WORD[j.light]}): ${j.reason}`,
              (cx) => requestLaunch(job, cx)));
    } else if (kind === "queued") {
      const est = currentVersion(job, running.estimates.get(job.id));
      right = est && !est.failed
        ? div().flex_none().text_size(11.5).text_color(t.muted).frames(SPINNER, 90)
        : div().flex_none().text_size(11.5).text_color(t.dim).child("Needs allocation");
    } else {
      const w = s.launched?.pr;
      const finished = isFinished(s);
      const brake = finished ? "" : brakeStatus(s.launched);
      const error = s.launched.braked?.error ?? w?.error;
      const tone = s.launched.braked && !finished ? LIGHT.yellow
        : !w ? t.dim : w.phase === "merged" || w.phase === "approved" ? LIGHT.green
        : w.phase === "needs-you" ? LIGHT.yellow : t.muted;
      right = h_flex().min_w(0).gap(4).items_center()
        .when(Boolean(error), (el) => el.child(div().id(`warn-${job.id}`).text_size(11).text_color(LIGHT.yellow)
          .tooltip(error).child("⚠")))
        .child(div().min_w(0).truncate().text_size(11).text_color(tone)
          .child(brake || (w ? prStatus(w) : s.launched?.at ? ago(s.launched.at) : "")))
        .when(finished, (el) => el.child(rowButton(t, `delete-${job.id}`, "Delete", true, `Delete ${job.title} from the queue`,
          (cx) => cx.spawn(async () => {
            const current = jobState(job.id);
            if (jobById(job.id)?.hash === job.hash && current.launched?.hash === job.hash && isFinished(current)) {
              await removeJob(job.id);
            }
          })).text_color(t.ansi1)));
    }
    const tip = kind === "launched"
      ? [routeText(s.launched.route), `${s.launched.branch} from ${baseText(s.launched.base)}`,
        !isFinished(s) ? brakeStatus(s.launched) : "", s.launched.braked?.reason, s.launched.pr?.error].filter(Boolean).join("\n")
      : [job.title, allocation ? routeText(allocation.route) : "Needs allocation", `${LIGHT_WORD[j.light]}: ${j.reason}`, waitText]
        .filter(Boolean).join("\n");
    return h_flex().id(`job-${kind}-${job.id}`).h(28).px(8).gap(8).flex_none().items_center().rounded(7)
      .cursor_pointer().hover((st) => st.bg(t.hover)).tooltip(tip)
      .on_click(() => this.openJob(job.id))
      .child(dot(j.light, 7))
      .child(this.rowTitle(t, job, kind, wait))
      .child(right);
  }

  /** A row's title, and "· after <job>" beside it on the same line for a job that's waiting. Both
   *  shrink and end in "…" when the row is short of room. */
  rowTitle(t, job, kind, wait) {
    const title = div().min_w(0).truncate().text_size(12.5).text_color(kind === "launched" ? t.muted : t.foreground).child(job.title);
    if (!wait) return title.flex_1();
    return h_flex().flex_1().min_w(0).gap(4).items_center()
      .child(title)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`· after ${wait.job.title}`));
  }

  renderSidebar(t) {
    const lists = classify(data.jobs, data.state);
    const header = h_flex().h(34).pl(16).pr(8).flex_none().items_center().gap(2)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child("Usage Queue"))
      .when(data.jobs.length > 0, (el) => el.child(div().id("open-map").size(24).flex_none().flex().items_center().justify_center()
        .rounded(6).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Dependency map: what's working, what's waiting, and what's merged").on_click(() => this.openMap())
        .child(svg("mods/usage-queue/map.svg").size(14))))
      .child(div().id("add-job").size(24).flex_none().flex().items_center().justify_center().rounded(6)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(draft ? "Add a job (continue your draft)" : "Add a job").on_click(() => this.openAdd())
          .child(svg("mods/workspace-chrome/plus.svg").size(14)));

    // Ready jobs keep the queue's order; waiting ones go newest first, so the oldest is at the bottom.
    const rows = [], waiting = [];
    for (const job of lists.queued) {
      const wait = blockedBy(job, data.jobs, data.state);
      if (wait) waiting.push({ job, wait });
      else rows.push(this.jobRow(t, job, "queued", wait));
    }
    const byJob = new Map(waiting.map((w) => [w.job, w.wait]));
    const waitingRows = newestFirst(waiting.map((w) => w.job)).map((job) => this.jobRow(t, job, "queued", byJob.get(job)));
    const showPause = hasScheduled() || lists.launched.some((job) => jobState(job.id).launched.braked && canBrake(jobState(job.id)));
    const pause = () => div().id("pause").flex_none().text_size(11).cursor_pointer()
      .text_color(data.state.paused ? LIGHT.yellow : t.dim).hover((st) => st.text_color(t.foreground))
      .tooltip(data.state.paused ? "Auto launches and resumes are paused. Click to continue." : "Pause Auto launches and resumes")
      .on_click((_e, cx) => cx.spawn(async () => setPaused(!data.state.paused)))
      .child(data.state.paused ? "Paused · resume" : "Pause auto");
    // With jobs waiting, the pause switch shares their heading's line instead of taking its own.
    const pauseInWaiting = showPause && waitingRows.length > 0;
    if (waitingRows.length) {
      rows.push(h_flex().id("waiting-head").px(8).pt(8).pb(2).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_medium().text_color(t.dim).child("Waiting for another job"))
        .when(waitingRows.length > 1, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim)
          .tooltip("Newest at the top, oldest at the bottom").child("oldest last ↓")))
        .when(pauseInWaiting, (el) => el.child(pause())));
      rows.push(...waitingRows);
    }
    for (const p of data.problems) {
      rows.push(h_flex().id(`problem-${p.id}`).h(24).px(8).gap(8).items_center().tooltip(`jobs/${p.id}.json: ${p.error}`)
        .child(dot("red", 7)).child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${p.id}.json: ${p.error}`)));
    }
    if (!rows.length) rows.push(div().id("empty").px(8).py(4).text_size(12).text_color(t.dim)
      .child(data.loaded ? "Queue is empty. Click + to add a job." : "Loading…"));
    if (lists.launched.length) {
      rows.push(div().id("launched-head").px(8).pt(8).pb(2).text_size(11).font_medium().text_color(t.dim).child("Launched"));
      for (const job of lists.launched.slice(0, 5)) rows.push(this.jobRow(t, job, "launched"));
    }
    return v_flex().id("root")
      .size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(header)
      .when(showPause && !pauseInWaiting, (el) => el.child(h_flex().px(16).pb(4).justify_end().child(pause())))
      .child(this.lightsRow(t))
      .child(v_flex().id("rows").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(rows));
  }

  // ---------- Dependency map ----------

  /** One job on the map: a card with a stripe in its stage's colour, its title and where it is. */
  mapNode(t, node, x, y) {
    const { job, stage } = node;
    const { text, color } = mapStatus(t, node);
    return h_flex().id(`map-${job.id}`).absolute().left(x).top(y).w(MAP.w).h(MAP.h).rounded(8).border_1()
      .border_color(stage === "working" ? t.working : t.border).bg(t.background).overflow_hidden()
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${job.title}\n${text}\nClick to open.`)
      .on_click(() => this.openJob(job.id))
      .child(div().w(3).h_full().flex_none().bg(MAP_STAGES[stage].color(t)))
      .child(v_flex().flex_1().min_w(0).px(10).gap(2).justify_center()
        .child(div().min_w(0).truncate().text_size(12.5).text_color(stage === "done" ? t.muted : t.foreground).child(job.title))
        .child(div().min_w(0).truncate().text_size(11).text_color(color).child(text)));
  }

  /** The arrows: from the bottom of the job waiting down to the top of the job it waits for.
   *  Solid green once that job is finished, dashed while it isn't. */
  mapEdges(t, map, spot) {
    const paint = globalThis.window?.paint_path;
    if (typeof paint !== "function" || typeof PathBuilder?.stroke !== "function" || !map.edges.length) return [];
    const els = [];
    for (const met of [false, true]) {
      const edges = map.edges.filter((e) => e.met === met);
      if (!edges.length) continue;
      let line = PathBuilder.stroke(1.5);
      if (!met) line = line.dash_array([4, 3]);
      let heads = PathBuilder.fill();
      for (const e of edges) {
        // From the job waiting (a) to the job it waits for (b), where the head is.
        const a = spot(e.to), b = spot(e.from);
        const x1 = a.x + MAP.w / 2, x2 = b.x + MAP.w / 2;
        // Normally the job waited for is lower down; a dependency set after launch can point up.
        const down = b.y > a.y;
        const y1 = down ? a.y + MAP.h : a.y, tip = down ? b.y : b.y + MAP.h;
        const y2 = down ? tip - 7 : tip + 7, bend = (down ? 1 : -1) * MAP.rowGap / 2;
        line = line.move_to(x1, y1).cubic_bezier_to(x2, y2, x1, y1 + bend, x2, y2 - bend);
        heads = heads.add_polygon([[x2, tip], [x2 - 4, y2], [x2 + 4, y2]], true);
      }
      const color = met ? LIGHT.green : t.dim;
      els.push(globalThis.window.paint_path(line.build(), color).absolute().inset_0());
      els.push(globalThis.window.paint_path(heads.build(), color).absolute().inset_0());
    }
    return els;
  }

  renderMap(t) {
    const p = props();
    const map = dependencyMap(data.jobs, data.state);
    const { x, y, width, height } = mapGeometry(map);
    const byId = new Map(map.nodes.map((n) => [n.job.id, { x: x(n.col), y: y(n.row) }]));
    const legend = h_flex().pt(6).gap(14).items_center().flex_wrap().children(Object.entries(MAP_STAGES).map(([stage, s]) =>
      h_flex().id(`legend-${stage}`).gap(6).items_center().tooltip(s.tip)
        .child(div().w(10).h(10).rounded(3).bg(s.color(t)))
        .child(div().text_size(11.5).text_color(t.muted).child(`${s.word} · ${map.counts[stage]}`))))
      .child(div().text_size(11.5).text_color(t.dim).child("dashed: still waits · green: cleared"));
    // Each band: its name in the gutter beside its top row, and a line above it.
    const bands = map.bands.flatMap((b, i) => {
      const top = y(b.to);
      const s = MAP_STAGES[b.stage];
      const els = [v_flex().id(`band-${b.stage}`).absolute().left(MAP.pad).top(top).w(MAP.gutter - 8).h(MAP.h).justify_center()
        .tooltip(s.tip)
        .child(div().text_size(11.5).font_medium().text_color(s.color(t)).child(s.word))
        .when(b.stage === "waiting" && b.to > b.from, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("later ↑ · sooner ↓")))];
      if (i < map.bands.length - 1) {
        els.push(div().absolute().left(MAP.pad).top(top - MAP.rowGap / 2).w(width - MAP.pad * 2).h(1).bg(t.border));
      }
      return els;
    });
    const canvas = map.nodes.length
      ? div().relative().flex_none().w(width).h(height)
        .children(bands)
        .children(this.mapEdges(t, map, (id) => byId.get(id)))
        .children(map.nodes.map((n) => this.mapNode(t, n, x(n.col), y(n.row))))
      : div().p(MAP.pad).text_size(12).text_color(t.dim).child(data.loaded ? "No jobs yet. Click + to add one." : "Loading…");
    return v_flex().id("map-dialog").size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child("Dependency map"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(4).text_size(11.5).text_color(t.dim)
        .child("Each job sits above the job it waits for. Click a job to open it."))
      .child(legend)
      .child(div().id("map-scroll-y").mt(12).flex_1().min_h(0).rounded(8).border_1().border_color(t.border).bg(t.canvas)
        .overflow_y_scrollbar()
        .child(div().id("map-scroll-x").w_full().overflow_x_scrollbar().child(canvas)))
      .child(h_flex().pt(12).child(div().flex_1()).child(button(t, "close", "Close", "secondary", () => closeOverlay(p.overlay))));
  }

  // ---------- Job dialog ----------

  initJob(cx) {
    loadIfNeeded(cx);
    // The elapsed time while this job's estimate runs: redraw once a second, only then.
    if (!checking()) {
      cx.timer.every(1000, (cx) => {
        const est = running.estimates.get(props()?.id);
        if (est && !est.failed) cx.notify();
      });
    }
  }

  togglePrompt(job, cx) {
    this.show = this.show === "prompt" ? null : "prompt";
    if (this.show === "prompt" && !currentVersion(job, lastRuns.get(job.id))?.prompt && !this.preview) {
      this.preview = "Reading the repository…";
      cx.spawn(async (cx) => {
        const preview = await buildEstimatePrompt(job, data.catalog, lightLines());
        if (this.editHash === job.hash) this.preview = preview;
        cx.notify();
      });
    }
    cx.notify();
  }

  textBox(t, id, text) {
    return div().id(id).mt(8).p(10).max_h(220).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border)
      .bg(t.background).text_size(11.5).text_color(t.muted).child(text || "(empty)");
  }

  currentRoute(job) {
    const s = jobState(job.id);
    const route = this.route
      ?? (currentVersion(job, s.estimate) ? s.proposal : null)
      ?? pinnedRoute(data.catalog, job)
      ?? proposeRoute(data.catalog, { routes: routeOptions(data.catalog, job, null), recommended: null }, data.pools, data.judged, job.permissions)
      ?? routeOptions(data.catalog, job, null)[0];
    return route && { ...route, size: this.size ?? route.size ?? "m" };
  }

  /** The dependency selected in the dialog, or the one from the file. */
  draftAfter(job) {
    const after = this.after === undefined ? job.after : this.after;
    return after && canWaitFor(job, data.jobs, data.state).some((o) => o.id === after) ? after : null;
  }

  async finishAllocation(cx, job, route, after, pr, action, overlay) {
    if (jobById(job.id)?.hash !== job.hash || allocationFor(job, data.state) ||
      running.allocations.has(job.id) || running.deletions.has(job.id)) return;
    running.allocations.add(job.id);
    changed();
    try {
      await saveAllocation(job, route, action === "auto" || (action === "save" && job.launch === "auto"), pr, after);
    } catch (e) {
      notify({ title: `Couldn't save allocation for ${job.title}`, body: String(e?.message ?? e), level: "error" });
      return;
    } finally {
      running.allocations.delete(job.id);
      changed();
    }
    const launchNow = action === "launch" || (action === "auto" && !dispatching &&
      dueToLaunch(data.jobs, data.state, data.catalog, data.pools, data.judged).includes(job));
    if (!launchNow || requestLaunch(job, cx, action === "auto")) closeOverlay(overlay);
  }

  /** A launched job's "finished" line: how it finishes, and Mark finished for when you say so. */
  finishedSection(t, job) {
    const launched = jobState(job.id).launched;
    const marked = Boolean(launched?.markedFinishedAt);
    const finished = isFinished(jobState(job.id));
    const waiting = data.jobs.filter((j) => j.id !== job.id && waitFor(j, data.state) === job.id);
    const text = marked ? `You marked it finished ${ago(launched.markedFinishedAt)}.`
      : finished ? "Finished."
        : launched?.pr && launched.pr.mode !== "off" ? "Finished once its PR is merged." : "Finished once its agent has worked and stopped.";
    return [h_flex().pt(10).gap(8).items_center()
      .child(div().flex_1().text_size(11.5).text_color(finished ? LIGHT.green : t.dim)
        .child(`${text}${waiting.length ? ` Waiting on it: ${waiting.map((j) => j.title).join(", ")}.` : ""}`))
      .when(marked || !finished, (el) => el.child(chip(t, "mark-finished", marked ? "Unmark finished" : "Mark finished", marked,
        (_e, cx) => cx.spawn(async () => { await markFinished(job, !marked); cx.notify(); }),
        marked ? "Jobs waiting on it wait again (unless they've launched)." : "Jobs waiting on it can launch now. Its PR, if any, is still watched.")))];
  }

  section(t, title) {
    return div().pt(16).pb(6).text_size(11.5).font_medium().text_color(t.dim).child(title);
  }

  estimateSection(t, job) {
    const run = running.estimates.get(job.id);
    const est = currentVersion(job, run);
    const { choices, suggested } = estimatorChoices(data.catalog, data.pools, data.judged, job.agents);
    const key = (c) => `${c.agent.id}/${c.model.id}`;
    const picked = choices.find((c) => key(c) === this.estimator && c.usable) ?? suggested;
    const els = [div().pt(6).pb(6).text_size(12).text_color(t.muted)
      .child("The estimate uses allowance to suggest a size, model and effort.")];
    els.push(v_flex().gap(2).children(choices.map((c) => {
      const selected = picked && key(c) === key(picked);
      const j = c.judgement ?? { light: "red", reason: "No allowance reading" };
      return h_flex().id(`est-${key(c)}`).h(30).px(8).gap(8).items_center().rounded(7).border_1()
        .border_color(selected ? t.accent : "#00000000").bg(selected ? t.selected : "#00000000")
        .when(c.usable, (el) => el.cursor_pointer().hover((st) => st.bg(selected ? t.selected : t.hover)))
        .when(!c.usable, (el) => el.opacity(0.5).cursor_not_allowed())
        .tooltip(`${LIGHT_WORD[j.light]}: ${j.reason}`)
        .on_click((_e, cx) => { if (c.usable) { this.estimator = key(c); cx.notify(); } })
        .child(dot(j.light))
        .child(div().text_size(12.5).text_color(t.foreground).child(`${c.agent.name} · ${c.model.label}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(j.reason))
        .when(suggested && key(c) === key(suggested), (el) => el.child(div().text_size(11).text_color(LIGHT.green).child("Suggested")));
    })));
    const busy = run && !run.failed;
    const lastRun = currentVersion(job, lastRuns.get(job.id));
    els.push(h_flex().pt(8).gap(8).items_center()
      .child(button(t, "run-estimate", busy ? `Estimating with ${run.label}…` : picked ? `Estimate with ${picked.agent.name} ${picked.model.label}` : "No big model has allowance",
        "secondary", (_e, cx) => {
          this.show = null;
          this.route = null;
          this.size = null;
          ask({ type: "estimate", id: job.id, hash: job.hash, agentId: picked.agent.id, modelId: picked.model.id }, cx);
        }, busy || !picked))
      .when(busy, (el) => el
        .child(div().text_size(12).text_color(t.muted).frames(SPINNER, 90))
        .child(div().text_size(12).text_color(t.muted).child(elapsed(Date.now() - run.startedAt))))
      .child(div().flex_1())
      .child(chip(t, "show-prompt", this.show === "prompt" ? "Hide prompt" : "Show prompt", this.show === "prompt",
        (_e, cx) => this.togglePrompt(job, cx)))
      .when(Boolean(lastRun && !busy), (el) => el.child(chip(t, "show-reply", this.show === "reply" ? "Hide reply" : "Show reply",
        this.show === "reply", (_e, cx) => { this.show = this.show === "reply" ? null : "reply"; cx.notify(); })))
      .when(Boolean(lastRun?.log && !busy), (el) => el.child(chip(t, "open-log", "Open log", false,
        (_e, cx) => cx.spawn(async () => exec("open", [lastRun.log])), lastRun.log))));
    if (est?.failed) els.push(div().pt(8).text_size(12).text_color(LIGHT.red).child(est.error));
    if (this.show === "prompt") els.push(this.textBox(t, "prompt-text", lastRun?.prompt || this.preview));
    if (this.show === "reply" && lastRun) {
      const text = [lastRun.reply || "(no reply)", lastRun.stderr?.trim() ? `\n--- ${lastRun.by.label} errors\n${lastRun.stderr.trim()}` : ""].join("");
      els.push(this.textBox(t, "reply-text", text));
    }
    return els;
  }

  allocationSection(t, job, route) {
    const s = jobState(job.id);
    const estimate = currentVersion(job, s.estimate);
    const pinned = pinnedRoute(data.catalog, job);
    const options = pinned && !estimate ? [pinned] : routeOptions(data.catalog, job, estimate);
    const els = [this.section(t, "Allocation")];
    els.push(v_flex().gap(4).children(options.map((r) => {
      const selected = route?.agent === r.agent;
      const { judgement: j } = jobRouteStatus(job, selected ? route : r);
      return v_flex().id(`route-${r.agent}`).px(10).py(6).gap(2).rounded(8).border_1()
        .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : "#00000000").cursor_pointer()
        .on_click((_e, cx) => { if (!selected) { this.route = { ...r }; cx.notify(); } })
        .child(h_flex().gap(8).items_center()
          .child(dot(j.light))
          .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(routeText(selected ? route : r)))
          .when(estimate?.recommended === r.agent, (el) => el.child(div().text_size(11).text_color(t.muted).child("recommended"))))
        .when(Boolean(r.why), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(r.why)))
        .child(div().text_size(11.5).text_color(t.dim).child(`${LIGHT_WORD[j.light]}: ${j.reason}`));
    })));
    const agent = agentOf(data.catalog, route?.agent);
    if (agent) {
      els.push(h_flex().pt(8).gap(4).flex_wrap().items_center()
        .child(div().w(52).text_size(11.5).text_color(t.dim).child("Model"))
        .children(agent.models.map((m) => chip(t, `model-${m.id}`, m.label, route.model === m.id,
          (_e, cx) => { this.route = { ...route, model: m.id }; cx.notify(); }, m.tier))));
      els.push(h_flex().pt(4).gap(4).flex_wrap().items_center()
        .child(div().w(52).text_size(11.5).text_color(t.dim).child("Effort"))
        .children(agent.efforts.map((e) => chip(t, `effort-${e}`, e, route.effort === e,
          (_e, cx) => { this.route = { ...route, effort: e }; cx.notify(); }))));
    }
    return els;
  }

  renderJob(t) {
    const p = props();
    const job = jobById(p.id);
    if (!job) {
      return v_flex().size_full().p(18).bg(t.popover).gap(8).text_color(t.foreground)
        .child(div().text_size(14).child(data.loaded ? "This job is gone." : "Loading…"))
        .child(h_flex().child(div().flex_1()).child(button(t, "close", "Close", "secondary", () => closeOverlay(p.overlay))));
    }
    if (this.editHash !== job.hash) {
      this.editHash = job.hash;
      this.route = this.size = this.estimator = this.show = null;
      this.after = this.pr = undefined;
      this.preview = "";
      this.showEstimator = false;
    }
    const s = jobState(job.id);
    const allocation = allocationFor(job, data.state);
    const launched = allocation && currentVersion(job, s.launched);
    const route = allocation?.route ?? this.currentRoute(job);
    const status = route ? jobRouteStatus(job, route).judgement : null;
    const after = allocation ? waitFor(job, data.state) : this.draftAfter(job);
    const wait = blockedBy(job, data.jobs, data.state, after);
    const pr = allocation?.pr ?? this.pr ?? job.pr;

    const body = [
      h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(job.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")),
      div().pt(4).text_size(11.5).text_color(t.dim)
        .child(`${job.repo} · ${job.agents.join(", ")} · priority ${job.priority} · ${job.id}.json`),
      div().pt(2).text_size(11.5).text_color(t.dim).child(`Starts from ${BASE_TEXT(job.base)}, taken when it launches.`),
      div().pt(2).text_size(11.5).text_color(t.dim)
        .child(`Permissions · ${PERMISSION_PROFILES[launched ? launched.permissions ?? "default" : job.permissions].label}`),
      div().id("prompt").mt(10).p(10).max_h(150).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border)
        .bg(t.background).text_size(12).text_color(t.foreground).child(job.prompt),
    ];

    if (allocation) {
      body.push(this.section(t, launched ? "Launched" : "Allocation"));
      body.push(h_flex().gap(8).items_center()
        .child(dot(status.light))
        .child(div().text_size(12.5).font_medium().child(routeText(route)))
        .child(div().text_size(11.5).text_color(t.dim).child(SIZE_LABEL[route.size] ?? "Medium")));
      body.push(div().pt(4).text_size(12).text_color(t.muted).child(`${LIGHT_WORD[status.light]}: ${status.reason}`));
      if (!launched && allocation.auto) {
        body.push(div().pt(8).text_size(12).text_color(t.accent).child(data.state.paused
          ? "Auto: scheduled launches are paused."
          : wait ? `Auto: launches by itself once ${wait.job.title} is finished and there's allowance.`
          : status.light === "red"
            ? `Auto: launches by itself when there's allowance${whenOpen(status) ? ` (next reset ${whenOpen(status)})` : ""}.`
            : "Auto: launches within a minute."));
      }
      if (launched) {
        body.push(div().pt(4).text_size(12).text_color(t.muted)
          .child(`${ago(s.launched.at)} on ${s.launched.branch}, from ${baseText(s.launched.base)}, in ${s.launched.folder}`));
        if (s.launched.base?.note) body.push(div().pt(4).text_size(12).text_color(LIGHT.yellow).child(s.launched.base.note));
        if (canBrake(s) || (!isFinished(s) && launched.takenOver)) {
          body.push(h_flex().pt(10).gap(8).items_center()
            .child(div().flex_1().text_size(12).text_color(launched.braked ? LIGHT.yellow : t.dim)
              .child(brakeStatus(launched) || "Allowance brake is on."))
            .when(!launched.noBrake && !launched.takenOver, (el) => el.child(chip(t, "let-finish", "Let it finish", false,
              (_e, cx) => cx.spawn(async () => { await letFinish(job, launched); cx.notify(); }),
              "Let this run spend its pool's reserve."))));
          if (launched.braked) body.push(div().pt(4).text_size(11.5).text_color(t.dim)
            .child(launched.braked.error ?? launched.braked.reason));
        }
        const w = s.launched.pr;
        if (w) {
          body.push(h_flex().pt(10).gap(8).items_center()
            .child(div().flex_1().text_size(12.5).font_medium().child(`${PR_MODE_TEXT[w.mode]}: ${prStatus(w)}`))
            .when(Boolean(w.url), (el) => el.child(chip(t, "open-pr", "Open PR", false, (_e, cx) => cx.spawn(async () => exec("open", [w.url])), w.url)))
            .when(!PR_DONE.has(w.phase), (el) => el.child(chip(t, "stop-watch", "Stop watching", false,
              (_e, cx) => cx.spawn(async () => { await patchWatch(job.id, { phase: "ended" }); cx.notify(); })))));
          body.push(div().pt(4).text_size(11.5).text_color(t.dim).child(w.number
            ? `Checked every 2 minutes. Review comments go to the agent, at most ${MAX_ROUNDS} rounds${w.mode === "merge" ? "; a 👍 merges it" : ""}.`
            : "Waiting for the agent to open the PR."));
          if (w.error) body.push(div().pt(4).text_size(11.5).text_color(LIGHT.yellow).child(w.error));
        }
        body.push(...this.finishedSection(t, job));
      }
    } else {
      body.push(this.section(t, "Size"));
      body.push(h_flex().gap(6).flex_wrap().items_center()
        .children(SIZES.map((size) => chip(t, `size-${size}`, SIZE_LABEL[size], route?.size === size,
          (_e, cx) => { this.size = size; cx.notify(); }, SIZE_TEXT[size])))
        .child(chip(t, "toggle-estimate", this.showEstimator ? "Hide estimate" : "Estimate with a model", this.showEstimator,
          (_e, cx) => { this.showEstimator = !this.showEstimator; cx.notify(); })));
      if (this.showEstimator) body.push(...this.estimateSection(t, job));
      if (route) body.push(...this.allocationSection(t, job, route));
      else body.push(div().pt(8).text_size(12).text_color(t.dim).child("Choose a job agent with a model and effort in the catalog."));
    }
    if (!launched) {
      body.push(this.section(t, "Wait for"));
      body.push(waitChips(t, after, canWaitFor(job, data.jobs, data.state), (id, cx) => {
        if (allocation) cx.spawn(async () => setAfter(job, id));
        else { this.after = id; cx.notify(); }
      }));
      body.push(div().pt(6).text_size(11.5).text_color(wait ? t.accent : t.dim).child(wait
        ? `Waits for ${wait.job.title}, which ${wait.why}. Then it starts from the remote's latest, so its work goes on top.`
        : after ? "What it waited for is finished: it can launch." : "Launches on its own terms. Pick a job to launch this one after it's finished (PR merged, or the agent done)."));
      if (wait && jobState(wait.job.id).launched) {
        body.push(h_flex().pt(6).child(chip(t, "mark-after-finished", `Mark ${wait.job.title} finished`, false,
          (_e, cx) => cx.spawn(async () => { await markFinished(wait.job, true); cx.notify(); }),
          "If it's done as far as you're concerned (you merged it, or it's good enough), this one can launch.")));
      }
      body.push(this.section(t, "When it's done"));
      body.push(h_flex().gap(6).items_center().children(["off", "review", "merge"].map((m) => chip(t, `pr-${m}`, PR_MODE_TEXT[m],
        pr === m, (_e, cx) => {
          if (allocation) cx.spawn(async () => setPrMode(job, m));
          else { this.pr = m; cx.notify(); }
        }))));
      body.push(div().pt(6).text_size(11.5).text_color(t.dim).child(pr === "off"
        ? "The agent just does the work."
        : `The agent opens a PR. The queue watches it: review comments go back to the agent (up to ${MAX_ROUNDS} rounds, each ending in "@codex review")${pr === "merge" ? ", and a 👍 merges it" : ", and you merge it"}.`));
    }

    const launching = running.launches.has(job.id);
    const busy = launching || running.brakes.has(job.id) || running.allocations.has(job.id) || running.deletions.has(job.id);
    const footer = h_flex().pt(18).gap(8).items_center()
      .child(button(t, "delete", "Delete job", "danger", (_e, cx) => cx.spawn(async () => {
        await removeJob(job.id);
        closeOverlay(p.overlay);
      }), busy))
      .child(div().flex_1());
    if (allocation) {
      footer.child(button(t, "clear-allocation", launched ? "Queue again" : "Clear allocation", "secondary",
        (_e, cx) => cx.spawn(async () => {
          this.route = null;
          this.size = null;
          this.after = undefined;
          this.pr = undefined;
          await clearAllocation(job);
          cx.notify();
        }), busy));
    }
    if (launched) {
      const space = agentSpace(job);
      footer.child(button(t, "go-to-agent", space ? "Go to agent" : "Agent closed", "primary",
        () => { if (space) { run("space.select", { id: space.id }); closeOverlay(p.overlay); } }, !space));
    } else {
      const finish = (action, cx) => cx.spawn(async (cx) => this.finishAllocation(cx, job, route, after, pr, action, p.overlay));
      if (!allocation) {
        footer.child(button(t, "save-allocation", "Save allocation", "secondary", (_e, cx) => finish("save", cx), busy || !route));
      }
      footer.child(allocation?.auto
        ? button(t, "auto", "Cancel Auto", "secondary", (_e, cx) => cx.spawn(async () => { await setAuto(job, false); cx.notify(); }), busy)
        : button(t, "auto", "Auto", "secondary", (_e, cx) => {
          if (!allocation) finish("auto", cx);
          else if (autoLaunch(job, cx)) closeOverlay(p.overlay);
        }, busy || !route));
      footer.child(button(t, "launch", launching ? "Launching…" : wait ? "Waiting" : status?.light === "red" ? "Not yet" : "Launch", "primary",
        (_e, cx) => {
          if (!allocation) finish("launch", cx);
          else if (requestLaunch(job, cx)) closeOverlay(p.overlay);
        }, busy || !route || Boolean(wait) || status?.light === "red"));
    }
    // The title and its details stay at the top, the buttons at the bottom; the rest scrolls.
    const head = body.splice(0, 2);
    return v_flex().id("job-dialog").size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(13)
      .children(head)
      .child(v_flex().id("job-body").flex_1().min_h(0).pr(8).overflow_y_scrollbar()
        .child(v_flex().flex_none().w_full().children(body)))
      .child(footer);
  }

  // ---------- Add dialog ----------

  initAdd(cx) {
    loadIfNeeded(cx);
    this.adding = true;
    this.draftSeq = 0;
    this.titleSeq = 0;
    this.titleStatus = null;
    this.prompt = TextareaState.new({ value: "", placeholder: "What the agent should do. It gets this as its first message.", rows: 7 });
    this.title = InputState.new({ value: "", placeholder: "Suggested from the prompt, or type your own" });
    this.prompt.on("change", (_e, cx) => {
      this.keepDraft(cx);
      if (!this.titleManual) this.scheduleTitle(cx);
      cx.notify();
    });
    this.title.on("change", (_e, cx) => {
      // Typing a title overrides the suggestion; clearing it hands the title back to the model.
      if (!this.settingTitle) {
        this.titleManual = Boolean(this.title.value().trim());
        this.titleSeq++;
        this.titleStatus = null;
        if (!this.titleManual) this.scheduleTitle(cx);
      }
      this.keepDraft(cx);
      cx.notify();
    });
    const f = focused();
    this.focusedRepo = (f?.pane && panes().find((pn) => pn.pane === f.pane)?.cwd) || "";
    this.repos = null;
    this.applyDraft(draft);
    cx.spawn(async (cx) => {
      this.repos = await repoChoices(this.focusedRepo);
      // The focused pane's folder becomes its repo's main checkout, or nothing outside a repo.
      if (this.repo === this.focusedRepo) this.repo = this.repos.find((r) => r.folders.includes(this.repo))?.path ?? "";
      cx.notify();
    });
    this.installed = null;
    this.error = "";
    if (checking()) return;
    // Opened before the sidebar read the draft: read it now, unless typing has begun.
    if (draft === undefined) {
      cx.spawn(async (cx) => {
        const saved = await loadDraft();
        if (draft === undefined) draft = saved;
        if (!this.title.value() && !this.prompt.value()) this.applyDraft(draft);
        cx.notify();
      });
    }
    this.prompt.focus();
    cx.timer.after(200, () => this.prompt.focus());
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents();
        this.installed = new Set(data.catalog.agents
          .filter((a) => known.some((k) => k.installed && k.run?.[0] === a.run[0]))
          .map((a) => a.id));
        for (const id of [...this.agents]) if (!this.installed.has(id)) this.agents.delete(id);
        if (!this.agents.size && this.installed.size) this.agents.add([...this.installed][0]);
      } catch {}
      cx.notify();
    });
  }

  // The other fields first: setting a text field may fire its change handler, which reads them.
  applyDraft(d) {
    this.repo = d?.repo || this.focusedRepo;
    this.agents = new Set(d?.agents ?? ["claude", "codex"]);
    this.priority = d?.priority ?? 2;
    this.prMode = d?.pr ?? "off";
    this.permissions = d?.permissions ?? "default";
    this.afterId = d?.after ?? null;
    // An older draft has no flag: a title in it was typed by hand.
    this.titleManual = Boolean(d?.title?.trim()) && (d?.titleManual ?? true);
    this.titleSeq++;
    this.titleStatus = null;
    this.setTitle(d?.title ?? "");
    this.prompt.set_value(d?.prompt ?? "");
  }

  /** Sets the title field without counting it as typed by hand. */
  setTitle(text) {
    this.settingTitle = true;
    try { this.title.set_value(text); } finally { this.settingTitle = false; }
  }

  /** Suggests a title once typing in the prompt stops, unless one was typed by hand. */
  scheduleTitle(cx, delay = TITLE_AFTER_MS) {
    const seq = ++this.titleSeq;
    cx.timer.after(delay, (cx) => {
      if (seq === this.titleSeq && !this.titleManual) this.suggest(cx, seq);
    });
  }

  /** One model request at a time: asked again while one runs, it runs once more afterwards, on
   *  the prompt as it is then, so a pause in typing doesn't start another process. */
  suggest(cx, seq = ++this.titleSeq) {
    if (this.titleBusy) {
      this.titleAgain = true;
      return;
    }
    const prompt = this.prompt.value().trim();
    if (prompt.length < TITLE_MIN_PROMPT) {
      this.titleStatus = null;
      return cx.notify();
    }
    const choices = titleChoices(data.catalog, {
      installed: this.installed, pools: data.pools, judged: data.judged, jobAgents: [...this.agents],
    });
    this.titleStatus = { busy: true, by: choices[0] ? `${choices[0].agent.name} ${choices[0].model.label}` : "" };
    cx.notify();
    this.titleBusy = true;
    this.titleAgain = false;
    cx.spawn(async (cx) => {
      let status = null;
      try {
        const { title, by } = await suggestTitle({ prompt, choices, exec, cwd: this.repo ? expandHome(this.repo) : undefined });
        status = { by, title };
      } catch (e) {
        status = { error: String(e?.message ?? e) };
      }
      this.titleBusy = false;
      if (this.titleAgain && !this.titleManual) return this.suggest(cx);
      if (seq !== this.titleSeq || this.titleManual) return;
      if (status.title) this.setTitle(status.title);
      this.titleStatus = status.title ? { by: status.by } : status;
      this.keepDraft(cx);
      cx.notify();
    });
  }

  /** Back to a suggested title, now. */
  resuggest(cx) {
    this.titleManual = false;
    this.suggest(cx);
  }

  /** Remembers the form now and writes it to disk shortly after typing stops. */
  keepDraft(cx) {
    if (!this.agents) return;
    const d = {
      title: this.title.value(), titleManual: this.titleManual, prompt: this.prompt.value(), repo: this.repo,
      agents: [...this.agents], priority: this.priority, pr: this.prMode, permissions: this.permissions, after: this.afterId, at: Date.now(),
    };
    draft = d.title.trim() || d.prompt.trim() ? d : null;
    const seq = ++this.draftSeq;
    cx.timer.after(500, (cx) => {
      if (seq === this.draftSeq) cx.spawn(async () => saveDraft(draft));
    });
  }

  clearDraft(cx) {
    this.applyDraft(null);
    this.keepDraft(cx);
    this.prompt.focus();
    cx.notify();
  }

  renderAdd(t) {
    const p = props();
    const title = this.title.value().trim();
    const prompt = this.prompt.value().trim();
    const can = Boolean(title && prompt && this.repo && this.agents.size);
    // Any job not finished yet; a new job has nothing waiting on it, so there's no loop.
    const waitOptions = data.jobs.filter((j) => !isFinished(jobState(j.id)));
    const afterId = waitOptions.some((j) => j.id === this.afterId) ? this.afterId : null;
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const status = this.titleStatus;
    const statusText = this.titleManual ? "· typed by you"
      : status?.busy ? `· suggesting${status.by ? ` with ${status.by}` : ""}…`
      : status?.error ? `· couldn't suggest one, so type it: ${status.error}`
      : status?.by && title ? `· suggested by ${status.by}, edit to override`
      : prompt.length < TITLE_MIN_PROMPT && !title ? "· suggested once you've written the prompt" : "";
    const save = (cx) => cx.spawn(async () => {
      if (!can) return;
      try {
        const id = jobId(title);
        await writeNewJob(id, jobText({
          title, prompt, repo: this.repo, agents: [...this.agents], priority: this.priority,
          pr: this.prMode, permissions: this.permissions, after: afterId,
        }));
        await record({ type: "added", job: id });
        draft = null;
        this.draftSeq++;
        await saveDraft(null);
        await reloadJobs();
        // Second step: the job's dialog opens on its launch options.
        closeOverlay(p.overlay);
        this.openJob(id);
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
    return v_flex().id("add-dialog").size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter" || e.keystroke === "ctrl-enter") { save(cx); cx.stop_propagation(); }
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(title || prompt ? "Add a job · draft" : "Add a job"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("add-body").flex_1().min_h(0).pr(8).overflow_y_scrollbar().child(v_flex().flex_none().w_full()
      .child(label("Prompt"))
      .child(Textarea.new(this.prompt).w_full().h(150).p(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8))
      .child(h_flex().items_end().gap(8)
        .child(label("Title"))
        .child(div().flex_1().min_w(0).pb(6).truncate().text_size(11).text_color(status?.error ? LIGHT.red : t.dim).child(statusText))
        .when(Boolean(this.titleManual || status?.error) && prompt.length >= TITLE_MIN_PROMPT, (el) => el.child(div().pb(4)
          .child(chip(t, "suggest-title", "Suggest", false, (_e, cx) => this.resuggest(cx),
            "Replace this title with one suggested from the prompt.")))))
      .child(Input.new(this.title).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8))
      .child(label("Repository (runs in a new worktree)"))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .children((this.repos ?? []).map((r, i) => chip(t, `repo-${i}`, r.name,
          r.folders.includes(expandHome(this.repo)), (_e, cx) => { this.repo = r.path; this.keepDraft(cx); cx.notify(); }, r.path)))
        .when(this.repos === null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Finding open repos…")))
        .child(button(t, "pick-repo", "Choose…", "secondary", (_e, cx) => cx.spawn(async (cx) => {
          const folder = await pickFolder({ prompt: "Use this repository" });
          if (folder) { this.repo = folder; this.keepDraft(cx); cx.notify(); }
        }))))
      .child(div().pt(6).truncate().text_size(11.5).text_color(this.repo ? t.muted : t.dim)
        .child(this.repo || "Choose a repo open in Herdr, or a folder"))
      .child(label("Agents that may do it"))
      .child(h_flex().gap(6).flex_wrap().children(data.catalog.agents.map((a) => {
        const missing = this.installed && !this.installed.has(a.id);
        return chip(t, `agent-${a.id}`, missing ? `${a.name} (not installed)` : a.name, this.agents.has(a.id), (_e, cx) => {
          if (missing) return;
          if (this.agents.has(a.id)) this.agents.delete(a.id); else this.agents.add(a.id);
          this.keepDraft(cx);
          cx.notify();
        });
      })))
      .child(label("Priority"))
      .child(h_flex().gap(6).children([1, 2, 3].map((n) => chip(t, `prio-${n}`, ["", "1 · high", "2 · normal", "3 · low"][n],
        this.priority === n, (_e, cx) => { this.priority = n; this.keepDraft(cx); cx.notify(); }))))
      .child(label("Permissions"))
      .child(h_flex().gap(6).children(Object.entries(PERMISSION_PROFILES).map(([profile, info]) => chip(t,
        `permissions-${profile}`, info.label, this.permissions === profile,
        (_e, cx) => { this.permissions = profile; this.keepDraft(cx); cx.notify(); }, info.description))))
      .child(label("When it's done"))
      .child(h_flex().gap(6).children(["off", "review", "merge"].map((m) => chip(t, `addpr-${m}`, PR_MODE_TEXT[m],
        this.prMode === m, (_e, cx) => { this.prMode = m; this.keepDraft(cx); cx.notify(); },
        m === "off" ? null : `Open a PR, then address review comments (up to ${MAX_ROUNDS} rounds)${m === "merge" ? " and merge it on a 👍" : ""}.`))))
      .when(waitOptions.length > 0, (el) => el
        .child(label("Wait for (launches only once that job is finished; newest first, oldest last)"))
        .child(waitChips(t, afterId, waitOptions, (id, cx) => { this.afterId = id; this.keepDraft(cx); cx.notify(); })))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(LIGHT.red).child(this.error)))
      .child(div().pt(10).text_size(11).text_color(t.dim)
        .child(`Saved as a file in ${paths().jobs}. ⌘↵ adds it. Esc or Close keeps this as a draft.`))
      ))
      .child(h_flex().pt(16).gap(8)
        .when(Boolean(title || prompt), (el) => el.child(button(t, "clear", "Clear", "secondary", (_e, cx) => this.clearDraft(cx))))
        .child(div().flex_1())
        .child(button(t, "cancel", "Close", "secondary", () => closeOverlay(p.overlay)))
        .child(button(t, "save", "Add to queue", "primary", (_e, cx) => save(cx), !can)));
  }

  render() {
    const t = theme();
    shared(REVISION);
    const p = props() ?? {};
    if (p.dialog === "add") return this.renderAdd(t);
    if (p.dialog === "job") return this.renderJob(t);
    if (p.dialog === "map") return this.renderMap(t);
    return this.renderSidebar(t);
  }
}
