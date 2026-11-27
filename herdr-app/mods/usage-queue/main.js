// Usage Queue: queue agent jobs and launch them on whichever subscription has allowance to spare.
//
// Three views of one mod:
// - the sidebar block (no props): Pending Launch Approval and Ready to Launch, behind two icons,
//   with a traffic light per coding agent;
// - the job dialog ({ dialog: "job", id }): estimate, review the proposal, approve, launch;
// - the add dialog ({ dialog: "add" }): a new job file.
//
// Data lives at module scope, shared by every copy; a change bumps a shared revision so every
// copy redraws. Slow work (estimates, launches) runs in the sidebar copy, so closing a dialog
// doesn't cancel it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  agents, checking, closeOverlay, exec, focused, knownAgents, notify, openOverlay, panes, pickFolder, props, run,
  setShared, shared, spaces, theme, watchFolder,
} from "herdr";
import { agentOf, estimatorEffort, launchArgv, mergeCatalog, modelOf } from "./catalog.js";
import { fetchPR, findPR, mergePR, myLogin, prState } from "./github.js";
import { buildEstimatePrompt, launchJob, runEstimate } from "./launch.js";
import { MAX_ROUNDS, reviewStep, roundMessage, sendArgs } from "./review.js";
import {
  agentLights, blockedBy, canWaitFor, isFinished, classify, dueToLaunch, routeOptions, estimatorChoices, jobId, jobText, pinnedRoute, proposeRoute, routeStatus,
} from "./queue.js";
import { judgeAll, poolsFromReport } from "./rule.js";
import {
  deleteJob, ensureFolders, loadCatalog, loadDraft, loadJobs, loadState, paths, readReport, record, saveDraft,
  updateState, writeNewJob,
} from "./store.js";
import { ago, duration } from "./time.js";

const ID = "usage-queue";
const REVISION = `${ID}.revision`;
const POLL_MS = 60_000;
/** After any launch on a pool, scheduled launches leave it alone this long: readings lag use. */
const SETTLE_MS = 10 * 60_000;
/** How often a PR (or the branch, before it has one) is checked on GitHub. */
const PR_POLL_MS = 2 * 60_000;
/** A PR watch with nothing happening for this long stops. */
const WATCH_FOR_MS = 24 * 3_600_000;
const PR_DONE = new Set(["merged", "closed", "needs-you", "ended"]);
/** A PR the queue stopped working on but that's still open: checked now and then for a merge,
 *  so a job waiting on it starts when you merge it yourself. */
const PR_LATE = new Set(["needs-you", "ended"]);
const LATE_POLL_MS = 10 * 60_000;
const LATE_FOR_MS = 14 * 24 * 3_600_000;
const PR_MODE_TEXT = { off: "No PR", review: "Open a PR", merge: "PR + merge on 👍" };
const BUSY_MS = 50_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Fixed light colors, as Usage Monitor's: their meaning shouldn't depend on the theme.
const LIGHT = { green: "#2fbf71", yellow: "#d4a72c", red: "#e5534b" };
const LIGHT_WORD = { green: "Ready", yellow: "Open", red: "Not yet" };
const ICON = {
  pending: "mods/workspace-chrome/clock.svg",
  ready: "mods/workspace-chrome/circle-check.svg",
  add: "mods/workspace-chrome/plus.svg",
  close: "mods/workspace-chrome/x.svg",
};

// --- Shared data ---

const data = {
  catalog: mergeCatalog(null),
  pools: [], judged: {}, readAt: 0, readError: "",
  state: { jobs: {} }, jobs: [], problems: [],
  loaded: false,
};
/** In-memory work: estimates and launches running now, by job id. */
const running = { estimates: new Map(), launches: new Set() };
/** Each job's last estimate run, for the dialog: { by, prompt, reply, error, log, at }. */
const lastRuns = new Map();
/** Work asked for by dialogs, run by a sidebar copy. */
const queue = [];
let workers = 0;
let readingSince = 0;
/** The add form as last typed: { title, prompt, repo, agents, priority }, or null. undefined
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
  if (Date.now() - readingSince < BUSY_MS) return;
  readingSince = Date.now();
  try {
    data.catalog = await loadCatalog();
    // Scheduled jobs need fresh readings even when Usage Monitor's readout isn't polling.
    const report = await readReport(scheduled().length > 0);
    data.pools = poolsFromReport(report);
    data.readAt = Date.now();
    data.readError = "";
  } catch (e) {
    data.readError = String(e?.message ?? e);
  } finally {
    readingSince = 0;
  }
  data.judged = judgeAll(data.pools);
  changed();
}

/** Approved jobs set to launch by themselves when there's allowance. */
const scheduled = () => classify(data.jobs, data.state).ready.filter((j) => jobState(j.id).approval?.auto);

/** Launches the scheduled jobs whose allowance is back (see dueToLaunch). */
async function launchScheduled() {
  for (const job of dueToLaunch(data.jobs, data.state, data.catalog, data.pools, data.judged, Date.now(), SETTLE_MS)) {
    if (!running.launches.has(job.id)) await doLaunch({ id: job.id, auto: true });
  }
}

const jobById = (id) => data.jobs.find((j) => j.id === id) ?? null;
const jobState = (id) => data.state.jobs?.[id] ?? {};
const lights = () => agentLights(data.catalog, data.pools, data.judged);
const lightLines = () => lights().map((l) => `${l.agent.id}: ${l.judgement.light} (${l.judgement.reason})`);

/** The light to show beside a job: its approved or proposed route's, else its agents' best. */
function jobLight(job) {
  const s = jobState(job.id);
  const route = s.approval?.hash === job.hash ? s.approval.route : s.proposal ?? pinnedRoute(data.catalog, job);
  if (route) return routeStatus(data.catalog, route, data.pools, data.judged).judgement;
  const own = lights().filter((l) => job.agents.includes(l.agent.id)).map((l) => l.judgement);
  const rank = { green: 2, yellow: 1, red: 0 };
  return own.sort((a, b) => rank[b.light] - rank[a.light])[0] ?? { light: "red", reason: "None of this job's agents has a reading" };
}

// --- Work: estimates and launches ---

async function doEstimate({ id, agentId, modelId }) {
  const job = jobById(id);
  const agent = agentOf(data.catalog, agentId);
  const model = modelOf(agent, modelId);
  if (!job || !agent || !model || running.estimates.has(id)) return;
  const effort = estimatorEffort(agent);
  running.estimates.set(id, { agent: agent.id, model: model.id, label: `${agent.name} ${model.label}`, startedAt: Date.now(), error: "" });
  changed();
  const by = { agent: agent.id, model: model.id, effort, label: `${agent.name} ${model.label}` };
  await record({ type: "estimate-started", job: id, by });
  let prompt = "";
  try {
    prompt = await buildEstimatePrompt(job, data.catalog, lightLines());
    lastRuns.set(id, { by, prompt, reply: "", error: "", log: null, at: Date.now() });
    changed();
    const { estimate, reply, log } = await runEstimate({ job, catalog: data.catalog, agent, model: model.id, effort, prompt });
    lastRuns.set(id, { by, prompt, reply, error: "", log, at: Date.now() });
    const proposal = proposeRoute(data.catalog, estimate, data.pools, data.judged);
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
    lastRuns.set(id, { by, prompt, reply: e?.reply ?? "", stderr: e?.stderr ?? "", error, log: e?.log ?? null, at: Date.now() });
    await record({ type: "estimate-failed", job: id, error, log: e?.log ?? null });
  }
  changed();
}

async function doLaunch({ id, auto = false }) {
  const job = jobById(id);
  const s = jobState(id);
  if (!job || running.launches.has(id) || s.approval?.hash !== job.hash) return;
  const wait = blockedBy(job, data.jobs, data.state);
  if (wait) return notify({ title: `${job.title}: waiting`, body: `It waits for ${wait.job.title}, which ${wait.why}.`, level: "warning" });
  const route = s.approval.route;
  const { agent, judgement, pool } = routeStatus(data.catalog, route, data.pools, data.judged);
  if (!agent) return notify({ title: "Can't launch", body: `Unknown agent ${route.agent}.`, level: "error" });
  if (judgement.light === "red") {
    return notify({ title: `${job.title}: not yet`, body: judgement.reason, level: "warning" });
  }
  running.launches.add(id);
  changed();
  try {
    const prMode = s.approval.pr ?? job.pr ?? "off";
    const launched = await launchJob({ job, agent, model: route.model, effort: route.effort, pr: prMode });
    const entry = { at: Date.now(), hash: job.hash, route, pool: pool?.id ?? null, light: judgement.light, ...launched };
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

/** The agent working in a launched job's worktree: its terminal address, or null. */
function agentIn(folder) {
  const cwd = new Map(panes().map((p) => [p.pane, p.cwd ?? ""]));
  return agents().find((a) => (cwd.get(a.pane) ?? "").startsWith(folder))?.address ?? null;
}

/** Hands a review round to the job's agent, or to a new one in its worktree if it's gone.
 *  Returns "" when it went, else why it didn't. */
async function sendRound(job, launched, message) {
  const terminal = launched.pr.terminal;
  const agent = terminal ? agents().find((a) => a.address === terminal) : null;
  if (agent) {
    const r = await exec("hc", sendArgs(terminal, agent.status, message), { timeout: 75_000 });
    if (r.code === 0) return "";
    return `hc send to ${terminal} (${agent.status ?? "no status"}) failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1) || `exit ${r.code}`}`;
  }
  const route = launched.route;
  const entry = agentOf(data.catalog, route.agent);
  if (!entry) return `Unknown agent ${route.agent}, so there's no one to start in ${launched.folder}.`;
  run("space.new", {
    folder: launched.folder, argv: launchArgv(entry, route.model, route.effort), focus: false,
    task: `You're continuing work on this branch (${launched.branch}), which has an open pull request.\n\n${message}`,
  });
  return "";
}

/** Checks every launched job that's waiting for its PR or under review, and takes the next step. */
async function watchPRs() {
  const now = Date.now();
  for (const job of data.jobs) {
    const launched = jobState(job.id).launched;
    if (launched && !launched.pr) await trackFinish(job.id, launched);
    const w = launched?.pr;
    if (w && PR_LATE.has(w.phase)) await lateCheck(job, launched, w, now);
    if (!w || PR_DONE.has(w.phase)) continue;
    const id = job.id;
    const terminal = (w.terminal && agents().some((a) => a.address === w.terminal)) ? w.terminal : agentIn(launched.folder);
    const agent = terminal ? agents().find((a) => a.address === terminal) : null;
    if (terminal !== w.terminal) await patchWatch(id, { terminal });
    if (agent?.status === "working" && !w.worked) await patchWatch(id, { worked: true });
    if (now - (polledAt.get(id) ?? 0) < PR_POLL_MS) continue;
    polledAt.set(id, now);
    if (now - (w.changedAt ?? launched.at) > WATCH_FOR_MS) {
      await patchWatch(id, { phase: "ended" });
      notify({ title: `Stopped watching: ${job.title}`, body: "Nothing happened for a day.", level: "info" });
      continue;
    }
    const idle = !agent || agent.status === "idle" || agent.status === "done";
    try {
      if (!w.number) {
        const found = await findPR(launched.folder, launched.branch);
        if (found) {
          await patchWatch(id, { number: found.number, url: found.url, phase: "in-review", changedAt: now });
          await record({ type: "pr-opened", job: id, number: found.number, url: found.url });
          notify({ title: `PR #${found.number} opened: ${job.title}`, body: "Watching it for reviews.", level: "info" });
        } else if (w.worked && agent && idle && !w.idleNoted) {
          await patchWatch(id, { idleNoted: true });
          notify({ title: `${job.title}: no PR yet`, body: "The agent stopped without opening one. It may be asking you something.", level: "warning" });
        }
        continue;
      }
      const pr = await fetchPR(launched.folder, w.number);
      const step = reviewStep(pr, w, await myLogin(launched.folder), idle);
      if (step.action === "merged" || step.action === "closed") {
        await patchWatch(id, { phase: step.action, changedAt: now });
        await record({ type: `pr-${step.action}`, job: id, number: w.number });
      } else if (step.action === "merge") {
        try {
          const how = await mergePR(launched.folder, w.number);
          await patchWatch(id, { phase: "merged", changedAt: now });
          await record({ type: "pr-merged", job: id, number: w.number, how, by: "queue" });
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
        const round = (w.rounds ?? 0) + 1;
        const message = roundMessage({ round, number: w.number, url: w.url, branch: launched.branch, items: step.items, mode: w.mode });
        const failed = await sendRound(job, launched, message);
        if (!failed) {
          await patchWatch(id, {
            rounds: round, sentAt: now, changedAt: now, handled: [...(w.handled ?? []), ...step.items.map((x) => x.id)],
            error: undefined, sendFailed: undefined,
          });
          await record({ type: "pr-round", job: id, number: w.number, round, comments: step.items.length });
          notify({ title: `Review round ${round}/${MAX_ROUNDS}: ${job.title}`, body: `${step.items.length} comment(s) sent to the agent.`, level: "info" });
        } else {
          // Tried again on the next poll; you hear about it once, not every two minutes.
          await patchWatch(id, { error: failed, sendFailed: true });
          if (!w.sendFailed) {
            await record({ type: "pr-round-failed", job: id, number: w.number, round, error: failed });
            notify({ title: `Couldn't send review round ${round}: ${job.title}`, body: `${failed}\nIt tries again every 2 minutes.`, level: "warning" });
          }
        }
      }
    } catch (e) {
      await patchWatch(id, { error: String(e?.message ?? e) });
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
    await patchWatch(job.id, { phase, changedAt: now });
    await record({ type: `pr-${phase}`, job: job.id, number: w.number, late: true });
    if (phase === "merged") {
      const waiting = data.jobs.filter((j) => (jobState(j.id).approval?.after ?? j.after) === job.id && !jobState(j.id).launched);
      if (waiting.length) notify({ title: `PR #${w.number} merged: ${job.title}`, body: `${waiting.map((j) => j.title).join(", ")} can launch now.`, level: "info" });
    }
  } catch {}
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
  if (launched.finishedAt || Date.now() - launched.at > WATCH_FOR_MS) return;
  const terminal = (launched.terminal && agents().some((a) => a.address === launched.terminal))
    ? launched.terminal : agentIn(launched.folder);
  const agent = terminal ? agents().find((a) => a.address === terminal) : null;
  const changes = {};
  if (terminal && terminal !== launched.terminal) changes.terminal = terminal;
  if (agent?.status === "working" && !launched.worked) changes.worked = true;
  const worked = launched.worked || changes.worked;
  if (worked && (!agent || agent.status === "idle" || agent.status === "done")) changes.finishedAt = Date.now();
  if (!Object.keys(changes).length) return;
  data.state = await updateState((s) => { if (s.jobs[id]?.launched) Object.assign(s.jobs[id].launched, changes); });
  if (changes.finishedAt) await record({ type: "finished", job: id });
  changed();
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
  data.state = await updateState((s) => { if (s.jobs[job.id]?.approval) s.jobs[job.id].approval.after = after; });
  await record({ type: "wait-for", job: job.id, after });
  changed();
}

async function setPrMode(job, pr) {
  data.state = await updateState((s) => { if (s.jobs[job.id]?.approval) s.jobs[job.id].approval.pr = pr; });
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

async function approve(job, route, auto, pr = "off") {
  data.state = await updateState((s) => {
    s.jobs[job.id] = { ...(s.jobs[job.id] ?? {}), approval: { at: Date.now(), hash: job.hash, route, auto, pr, after: job.after } };
  });
  await record({ type: "approved", job: job.id, route, auto, pr });
  changed();
}

/** Turns "launch when there's allowance" on or off for an approved job. */
async function setAuto(job, auto) {
  data.state = await updateState((s) => {
    if (s.jobs[job.id]?.approval) s.jobs[job.id].approval.auto = auto;
  });
  await record({ type: auto ? "scheduled" : "unscheduled", job: job.id });
  changed();
}

async function setPaused(paused) {
  data.state = await updateState((s) => { s.paused = paused; });
  await record({ type: paused ? "paused" : "resumed" });
  changed();
}

/**
 * The Auto button: with allowance now, the same as Launch; without, the job launches by itself
 * as soon as there is. Returns false when the launch runs in this copy (see ask).
 */
function autoLaunch(job, cx) {
  if (jobLight(job).light !== "red" && !blockedBy(job, data.jobs, data.state)) return ask({ type: "launch", id: job.id }, cx);
  cx.spawn(async () => setAuto(job, true));
  return true;
}

/** When a red light should change, for people: "in 2h 10m", or "" when unknown. */
const whenOpen = (j) => (j.changesAt && j.changesAt > Date.now() ? `in ${duration(j.changesAt - Date.now())}` : "");

async function unapprove(job) {
  data.state = await updateState((s) => {
    const entry = s.jobs[job.id] ?? {};
    delete entry.approval;
    delete entry.launched;
    s.jobs[job.id] = entry;
  });
  await record({ type: "unapproved", job: job.id });
  changed();
}

// --- Small pieces ---

const elapsed = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : duration(ms));

const dot = (light, size = 8) => div().size(size).flex_none().rounded(size).bg(LIGHT[light] ?? "#888888");

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

// --- The view ---

export default class UsageQueue extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.width = Infinity;
    if (p.dialog === "add") return this.initAdd(cx);
    if (p.dialog === "job") return this.initJob(cx);

    this.tab = localStorage.getItem("tab") === "ready" ? "ready" : "pending";
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
    cx.timer.every(POLL_MS, (cx) => cx.spawn(async () => {
      await refreshReadings();
      await launchScheduled();
    }));
    // Launched jobs' PRs: each is checked on GitHub every 2 minutes (see watchPRs).
    cx.timer.every(30_000, (cx) => cx.spawn(async () => watchPRs()));
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

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("tab", tab);
    cx.notify();
  }

  openJob(id) {
    // A fixed share of the window: the middle scrolls, the title and buttons stay put.
    openOverlay({ mod: ID, kind: "dialog", width: 580, height: 0.85, props: { dialog: "job", id } });
  }

  openAdd() {
    openOverlay({ mod: ID, kind: "dialog", width: 560, height: 0.85, props: { dialog: "add" } });
  }

  tabButton(t, key, icon, label, count, narrow) {
    const active = this.tab === key;
    return h_flex().id(`tab-${key}`).h(26).px(narrow ? 0 : 8).when(narrow, (el) => el.w(32).justify_center())
      .gap(6).flex_none().items_center().rounded(6).cursor_pointer()
      .bg(active ? t.selected : "#00000000").hover((s) => s.bg(active ? t.selected : t.hover))
      .tooltip(label)
      .on_click((_e, cx) => this.setTab(key, cx))
      .child(svg(icon).size(14).flex_none().text_color(active ? t.foreground : t.muted))
      .child(div().text_size(11.5).font_medium().text_color(count ? (active ? t.foreground : t.muted) : t.dim).child(String(count)));
  }

  lightsRow(t) {
    const list = lights();
    if (!list.length) {
      return div().px(16).pb(6).text_size(11.5).text_color(t.dim).truncate()
        .child(data.readError || (data.readAt ? "No coding agent readings" : "Reading allowance…"))
        .when(Boolean(data.readError), (el) => el.id("read-error").tooltip(data.readError));
    }
    return h_flex().id("lights").px(16).pb(6).gap(12).flex_none().items_center().children(list.map((l) => {
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

  jobRow(t, job, kind) {
    const s = jobState(job.id);
    const j = kind === "launched" ? { light: s.launched?.light ?? "yellow", reason: "" } : jobLight(job);
    const est = running.estimates.get(job.id);
    let right = null;
    if (kind === "ready") {
      const launching = running.launches.has(job.id);
      const auto = s.approval?.auto;
      const wait = blockedBy(job, data.jobs, data.state);
      const red = j.light === "red";
      const waitText = wait ? `Waits for ${wait.job.title}, which ${wait.why}.` : "";
      right = launching
        ? div().text_size(11.5).text_color(t.muted).frames(SPINNER, 90)
        : auto
          ? rowButton(t, `auto-${job.id}`, data.state.paused ? "Paused" : wait ? "Auto after" : `Auto ${red ? whenOpen(j) : "now"}`.trim(), true,
            `Launches by itself ${wait ? `once ${wait.job.title} is finished and ` : "when "}there's allowance${data.state.paused ? " (scheduled launches are paused)" : ""}.${wait ? ` ${waitText}` : ""} Now: ${j.reason}\nClick to cancel.`,
            (cx) => cx.spawn(async () => setAuto(job, false)), true)
          : h_flex().gap(4).flex_none()
            .child(rowButton(t, `auto-${job.id}`, "Auto", true, wait
              ? `Launch by itself once ${wait.job.title} is finished and there's allowance. ${waitText}`
              : red ? `Launch by itself when there's allowance. Now: ${j.reason}`
                : `There's allowance now, so this launches now, like Launch (${LIGHT_WORD[j.light]}: ${j.reason}).`,
            (cx) => autoLaunch(job, cx)))
            .child(rowButton(t, `launch-${job.id}`, "Launch", !red && !wait,
              wait ? waitText : red ? `Not yet: ${j.reason}` : `Launch now (${LIGHT_WORD[j.light]}): ${j.reason}`,
              (cx) => ask({ type: "launch", id: job.id }, cx)));
    } else if (kind === "pending") {
      const text = est && !est.failed ? null : s.estimate?.hash === job.hash || pinnedRoute(data.catalog, job) ? "Review" : est?.failed ? "Failed" : "Choose";
      right = text === null
        ? div().text_size(11.5).text_color(t.muted).frames(SPINNER, 90)
        : div().text_size(11.5).text_color(text === "Failed" ? LIGHT.red : t.dim).child(text);
    } else {
      const w = s.launched?.pr;
      const tone = !w ? t.dim : w.phase === "merged" || w.phase === "approved" ? LIGHT.green
        : w.phase === "needs-you" ? LIGHT.yellow : t.muted;
      right = div().text_size(11).text_color(tone).child(w ? prStatus(w) : s.launched?.at ? ago(s.launched.at) : "");
    }
    const tip = kind === "launched"
      ? `${routeText(s.launched.route)}\n${s.launched.branch} from ${baseText(s.launched.base)}`
      : `${job.title}\n${LIGHT_WORD[j.light]}: ${j.reason}${s.approval?.hash === job.hash ? `\n${routeText(s.approval.route)}` : ""}`;
    return h_flex().id(`job-${kind}-${job.id}`).h(28).px(8).gap(8).flex_none().items_center().rounded(7)
      .cursor_pointer().hover((st) => st.bg(t.hover)).tooltip(tip)
      .on_click(() => this.openJob(job.id))
      .child(dot(j.light, 7))
      .child(this.rowTitle(t, job, kind))
      .child(right);
  }

  /** A row's title, and "· after <job>" beside it on the same line for a job that's waiting. Both
   *  shrink and end in "…" when the row is short of room. */
  rowTitle(t, job, kind) {
    const wait = kind === "ready" ? blockedBy(job, data.jobs, data.state) : null;
    const title = div().min_w(0).truncate().text_size(12.5).text_color(kind === "launched" ? t.muted : t.foreground).child(job.title);
    if (!wait) return title.flex_1();
    return h_flex().flex_1().min_w(0).gap(4).items_center()
      .child(title)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`· after ${wait.job.title}`));
  }

  renderSidebar(t) {
    const narrow = this.width < 160;
    const lists = classify(data.jobs, data.state);
    if (narrow) {
      return v_flex().id("root").on_size_change((size, cx) => this.resized(size, cx)).size_full()
        .bg(t.chrome).border_t(1).border_color(t.border).pt(6).gap(4).items_center()
        .child(this.tabButton(t, "pending", ICON.pending, "Pending Launch Approval", lists.pending.length, true))
        .child(this.tabButton(t, "ready", ICON.ready, "Ready to Launch", lists.ready.length, true));
    }
    // A section title like the sidebar's others (Spaces, Agents, Context, Prompts), with the two
    // views and + at its right.
    const header = h_flex().h(34).pl(16).pr(8).flex_none().items_center().gap(2)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child("Usage Queue"))
      .child(this.tabButton(t, "pending", ICON.pending, "Pending Launch Approval", lists.pending.length, narrow))
      .child(this.tabButton(t, "ready", ICON.ready, "Ready to Launch", lists.ready.length, narrow))
      .child(div().id("add-job").size(24).flex_none().flex().items_center().justify_center().rounded(6)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(draft ? "Add a job (continue your draft)" : "Add a job").on_click(() => this.openAdd())
          .child(svg(ICON.add).size(14)));

    const rows = [];
    if (this.tab === "pending") {
      for (const job of lists.pending) rows.push(this.jobRow(t, job, "pending"));
      for (const p of data.problems) {
        rows.push(h_flex().id(`problem-${p.id}`).h(24).px(8).gap(8).items_center().tooltip(`jobs/${p.id}.json: ${p.error}`)
          .child(dot("red", 7)).child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${p.id}.json: ${p.error}`)));
      }
      if (!rows.length) rows.push(div().id("empty").px(8).py(4).text_size(12).text_color(t.dim)
        .child(data.loaded ? "Nothing waits for approval. Click + to add a job." : "Loading…"));
    } else {
      for (const job of lists.ready) rows.push(this.jobRow(t, job, "ready"));
      if (!lists.ready.length) rows.push(div().id("empty").px(8).py(4).text_size(12).text_color(t.dim)
        .child("Approved jobs wait here until you launch them."));
      if (lists.launched.length) {
        rows.push(div().id("launched-head").px(8).pt(8).pb(2).text_size(11).font_medium().text_color(t.dim).child("Launched"));
        for (const job of lists.launched.slice(0, 5)) rows.push(this.jobRow(t, job, "launched"));
      }
    }

    return v_flex().id("root").on_size_change((size, cx) => this.resized(size, cx))
      .size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(header)
      .child(h_flex().px(16).pb(4).gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim)
          .child(this.tab === "pending" ? "Pending launch approval" : "Ready to launch"))
        .when(this.tab === "ready" && scheduled().length > 0, (el) => el.child(
          div().id("pause").text_size(11).cursor_pointer()
            .text_color(data.state.paused ? LIGHT.yellow : t.dim).hover((st) => st.text_color(t.foreground))
            .tooltip(data.state.paused ? "Scheduled launches are paused. Click to resume." : "Pause scheduled launches")
            .on_click((_e, cx) => cx.spawn(async () => setPaused(!data.state.paused)))
            .child(data.state.paused ? "Paused · resume" : "Pause auto"))))
      .child(this.lightsRow(t))
      .child(v_flex().id("rows").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(rows));
  }

  resized(size, cx) {
    if (size.width === this.width) return;
    this.width = size.width;
    cx.notify();
  }

  // ---------- Job dialog ----------

  initJob(cx) {
    loadIfNeeded(cx);
    this.estimator = null; // "agent/model" picked to run the estimate
    this.route = null; // the proposal as edited here
    this.show = null; // "prompt" | "reply": the text box under the estimate
    this.preview = ""; // the prompt an estimate would send, before any run
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
    if (this.show === "prompt" && !lastRuns.get(job.id)?.prompt && !this.preview) {
      this.preview = "Reading the repository…";
      cx.spawn(async (cx) => {
        this.preview = await buildEstimatePrompt(job, data.catalog, lightLines());
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
    if (this.route) return this.route;
    if (s.approval?.hash === job.hash) return s.approval.route;
    const estimate = s.estimate?.hash === job.hash ? s.estimate : null;
    if (s.proposal && estimate) return s.proposal;
    // No estimate: start from the defaults, on the agent with the most allowance to spare.
    return pinnedRoute(data.catalog, job)
      ?? proposeRoute(data.catalog, { routes: routeOptions(data.catalog, job, null), recommended: null }, data.pools, data.judged);
  }

  /** A launched job's "finished" line: how it finishes, and Mark finished for when you say so. */
  finishedSection(t, job) {
    const launched = jobState(job.id).launched;
    const marked = Boolean(launched?.markedFinishedAt);
    const finished = isFinished(jobState(job.id));
    const waiting = data.jobs.filter((j) => j.id !== job.id && (jobState(j.id).approval?.after ?? j.after) === job.id);
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
    const s = jobState(job.id);
    const est = running.estimates.get(job.id);
    const { choices, suggested } = estimatorChoices(data.catalog, data.pools, data.judged, job.agents);
    const key = (c) => `${c.agent.id}/${c.model.id}`;
    const picked = choices.find((c) => key(c) === this.estimator && c.usable) ?? suggested;
    const els = [this.section(t, s.estimate?.hash === job.hash ? "1 · Estimate (done; run again to refresh)" : "1 · Estimate model and effort (optional)")];
    els.push(div().pb(6).text_size(12).text_color(t.muted)
      .child("A big model reads the job and recommends a model, effort and size for each agent. It uses allowance too, so it runs only when you click. Or skip it and choose below."));
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
    const busy = est && !est.failed;
    const lastRun = lastRuns.get(job.id);
    els.push(h_flex().pt(8).gap(8).items_center()
      .child(button(t, "run-estimate", busy ? `Estimating with ${est.label}…` : picked ? `Estimate with ${picked.agent.name} ${picked.model.label}` : "No big model has allowance",
        "secondary", (_e, cx) => {
          this.show = null;
          ask({ type: "estimate", id: job.id, agentId: picked.agent.id, modelId: picked.model.id }, cx);
        }, busy || !picked))
      .when(busy, (el) => el
        .child(div().text_size(12).text_color(t.muted).frames(SPINNER, 90))
        .child(div().text_size(12).text_color(t.muted).child(elapsed(Date.now() - est.startedAt))))
      .child(div().flex_1())
      .child(chip(t, "show-prompt", this.show === "prompt" ? "Hide prompt" : "Show prompt", this.show === "prompt",
        (_e, cx) => this.togglePrompt(job, cx)))
      .when(Boolean(lastRun && !busy), (el) => el.child(chip(t, "show-reply", this.show === "reply" ? "Hide reply" : "Show reply",
        this.show === "reply", (_e, cx) => { this.show = this.show === "reply" ? null : "reply"; cx.notify(); })))
      .when(Boolean(lastRun?.log && !busy), (el) => el.child(chip(t, "open-log", "Open log", false,
        (_e, cx) => cx.spawn(async () => exec("open", [lastRun.log])), lastRun.log))));
    if (est?.failed) els.push(div().pt(8).text_size(12).text_color(LIGHT.red).child(est.error));
    if (busy) {
      els.push(div().pt(6).text_size(11.5).text_color(t.dim)
        .child(`${est.label} answers in one go when it's done: the reply and a log show here then. Closing this dialog doesn't stop it.`));
    }
    if (this.show === "prompt") els.push(this.textBox(t, "prompt-text", lastRun?.prompt || this.preview));
    if (this.show === "reply" && lastRun) {
      const text = [lastRun.reply || "(no reply)", lastRun.stderr?.trim() ? `\n--- ${lastRun.by.label} errors\n${lastRun.stderr.trim()}` : ""].join("");
      els.push(this.textBox(t, "reply-text", text));
    }
    return els;
  }

  proposalSection(t, job, route) {
    const s = jobState(job.id);
    const estimate = s.estimate?.hash === job.hash ? s.estimate : null;
    const pinned = pinnedRoute(data.catalog, job);
    const options = pinned && !estimate ? [pinned] : routeOptions(data.catalog, job, estimate);
    const els = [this.section(t, estimate ? "2 · Proposal: approve as is, or adjust"
      : pinned ? "2 · Set in the job file: approve as is, or adjust"
        : "2 · Choose the agent, model and effort, or estimate above")];
    els.push(v_flex().gap(4).children(options.map((r) => {
      const selected = route?.agent === r.agent;
      const { judgement: j } = routeStatus(data.catalog, selected ? route : r, data.pools, data.judged);
      return v_flex().id(`route-${r.agent}`).px(10).py(6).gap(2).rounded(8).border_1()
        .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : "#00000000").cursor_pointer()
        .on_click((_e, cx) => { if (!selected) { this.route = { ...r }; cx.notify(); } })
        .child(h_flex().gap(8).items_center()
          .child(dot(j.light))
          .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(routeText(selected ? route : r)))
          .child(div().text_size(11.5).text_color(t.dim).child(`size ${(selected ? route : r).size}`))
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
    const s = jobState(job.id);
    const approved = s.approval?.hash === job.hash;
    const launched = approved && s.launched?.hash === job.hash;
    const route = this.currentRoute(job);
    const status = route ? routeStatus(data.catalog, route, data.pools, data.judged).judgement : null;

    const body = [
      h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().child(job.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")),
      div().pt(4).text_size(11.5).text_color(t.dim)
        .child(`${job.repo} · ${job.agents.join(", ")} · priority ${job.priority} · ${job.id}.json`),
      div().pt(2).text_size(11.5).text_color(t.dim).child(`Starts from ${BASE_TEXT(job.base)}, taken when it launches.`),
      div().id("prompt").mt(10).p(10).max_h(150).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border)
        .bg(t.background).text_size(12).text_color(t.foreground).child(job.prompt),
    ];

    if (approved) {
      body.push(this.section(t, launched ? "Launched" : "Approved: ready to launch"));
      body.push(h_flex().gap(8).items_center()
        .child(dot(status.light))
        .child(div().text_size(12.5).font_medium().child(routeText(route)))
        .child(div().text_size(11.5).text_color(t.dim).child(`size ${route.size ?? "m"}`)));
      body.push(div().pt(4).text_size(12).text_color(t.muted).child(`${LIGHT_WORD[status.light]}: ${status.reason}`));
      if (!launched && s.approval.auto) {
        const waiting = blockedBy(job, data.jobs, data.state);
        body.push(div().pt(8).text_size(12).text_color(t.accent).child(data.state.paused
          ? "Auto: scheduled launches are paused."
          : waiting ? `Auto: launches by itself once ${waiting.job.title} is finished and there's allowance.`
          : status.light === "red"
            ? `Auto: launches by itself when there's allowance${whenOpen(status) ? ` (next reset ${whenOpen(status)})` : ""}.`
            : "Auto: launches within a minute."));
      }
      if (launched) {
        body.push(div().pt(4).text_size(12).text_color(t.muted)
          .child(`${ago(s.launched.at)} on ${s.launched.branch}, from ${baseText(s.launched.base)}, in ${s.launched.folder}`));
        if (s.launched.base?.note) body.push(div().pt(4).text_size(12).text_color(LIGHT.yellow).child(s.launched.base.note));
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
      if (!pinnedRoute(data.catalog, job)) body.push(...this.estimateSection(t, job));
      if (route) body.push(...this.proposalSection(t, job, route));
    }
    // Waiting for another job: it launches only once that one is finished.
    if (approved && !launched) {
      const after = s.approval.after ?? null;
      const wait = blockedBy(job, data.jobs, data.state);
      const options = canWaitFor(job, data.jobs, data.state);
      body.push(this.section(t, "Wait for"));
      body.push(h_flex().gap(6).flex_wrap().items_center()
        .child(chip(t, "after-none", "Nothing", !after, (_e, cx) => cx.spawn(async () => setAfter(job, null))))
        .children(options.map((o) => chip(t, `after-${o.id}`, o.title, after === o.id,
          (_e, cx) => cx.spawn(async () => setAfter(job, o.id)), o.id))));
      body.push(div().pt(6).text_size(11.5).text_color(wait ? t.accent : t.dim).child(wait
        ? `Waits for ${wait.job.title}, which ${wait.why}. Then it starts from the remote's latest, so its work goes on top.`
        : after ? "What it waited for is finished: it can launch." : "Launches on its own terms. Pick a job to launch this one after it's finished (PR merged, or the agent done)."));
      if (wait && jobState(wait.job.id).launched) {
        body.push(h_flex().pt(6).child(chip(t, "mark-after-finished", `Mark ${wait.job.title} finished`, false,
          (_e, cx) => cx.spawn(async () => { await markFinished(wait.job, true); cx.notify(); }),
          "If it's done as far as you're concerned (you merged it, or it's good enough), this one can launch.")));
      }
    }
    // When it's done: a PR, and its reviews. Chosen before launch.
    if (!launched) {
      const current = approved ? s.approval.pr ?? job.pr : (this.pr ??= job.pr);
      body.push(this.section(t, "When it's done"));
      body.push(h_flex().gap(6).items_center().children(["off", "review", "merge"].map((m) => chip(t, `pr-${m}`, PR_MODE_TEXT[m],
        current === m, (_e, cx) => {
          if (approved) cx.spawn(async () => setPrMode(job, m));
          else { this.pr = m; cx.notify(); }
        }))));
      body.push(div().pt(6).text_size(11.5).text_color(t.dim).child(current === "off"
        ? "The agent just does the work."
        : `The agent opens a PR. The queue watches it: review comments go back to the agent (up to ${MAX_ROUNDS} rounds, each ending in "@codex review")${current === "merge" ? ", and a 👍 merges it" : ", and you merge it"}.`));
    }

    const launching = running.launches.has(job.id);
    const footer = h_flex().pt(18).gap(8).items_center()
      .child(button(t, "delete", "Delete job", "danger", (_e, cx) => cx.spawn(async () => {
        await deleteJob(job.id);
        await record({ type: "deleted", job: job.id });
        await reloadJobs();
        closeOverlay(p.overlay);
      })))
      .child(div().flex_1());
    if (approved) {
      footer.child(button(t, "unapprove", launched ? "Queue again" : "Unapprove", "secondary",
        (_e, cx) => cx.spawn(async () => { this.route = null; await unapprove(job); cx.notify(); })));
      if (launched) {
        const space = agentSpace(job);
        footer.child(button(t, "go-to-agent", space ? "Go to agent" : "Agent closed", "primary",
          () => { if (space) { run("space.select", { id: space.id }); closeOverlay(p.overlay); } }, !space));
      }
      if (!launched) {
        footer.child(s.approval.auto
          ? button(t, "auto", "Cancel Auto", "secondary", (_e, cx) => cx.spawn(async () => { await setAuto(job, false); cx.notify(); }))
          : button(t, "auto", "Auto", "secondary", (_e, cx) => { if (autoLaunch(job, cx)) closeOverlay(p.overlay); }, launching));
        const waiting = Boolean(blockedBy(job, data.jobs, data.state));
        footer.child(button(t, "launch", launching ? "Launching…" : waiting ? "Waiting" : status.light === "red" ? "Not yet" : "Launch", "primary",
          (_e, cx) => { if (ask({ type: "launch", id: job.id }, cx)) closeOverlay(p.overlay); }, launching || waiting || status.light === "red"));
      }
    } else {
      footer.child(button(t, "approve", "Approve", "primary", (_e, cx) => cx.spawn(async () => {
        // Approving never launches; "launch": "auto" in the file starts it on Auto.
        await approve(job, { size: "m", why: "", ...route }, job.launch === "auto", this.pr ?? job.pr);
        closeOverlay(p.overlay);
      }), !route));
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
    this.title = InputState.new({ value: "", placeholder: "e.g. Find and fix flaky tests" });
    this.prompt = TextareaState.new({ value: "", placeholder: "What the agent should do. It gets this as its first message.", rows: 7 });
    for (const input of [this.title, this.prompt]) input.on("change", (_e, cx) => { this.keepDraft(cx); cx.notify(); });
    this.title.on("submit", () => this.prompt.focus());
    const f = focused();
    this.focusedRepo = (f?.pane && panes().find((pn) => pn.pane === f.pane)?.cwd) || "";
    this.applyDraft(draft);
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
    this.title.focus();
    cx.timer.after(200, () => this.title.focus());
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
    this.title.set_value(d?.title ?? "");
    this.prompt.set_value(d?.prompt ?? "");
  }

  /** Remembers the form now and writes it to disk shortly after typing stops. */
  keepDraft(cx) {
    if (!this.agents) return;
    const d = {
      title: this.title.value(), prompt: this.prompt.value(), repo: this.repo,
      agents: [...this.agents], priority: this.priority, pr: this.prMode, at: Date.now(),
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
    this.title.focus();
    cx.notify();
  }

  renderAdd(t) {
    const p = props();
    const title = this.title.value().trim();
    const prompt = this.prompt.value().trim();
    const can = Boolean(title && prompt && this.repo && this.agents.size);
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const save = (cx) => cx.spawn(async () => {
      if (!can) return;
      try {
        const id = jobId(title);
        await writeNewJob(id, jobText({ title, prompt, repo: this.repo, agents: [...this.agents], priority: this.priority, pr: this.prMode }));
        await record({ type: "added", job: id });
        draft = null;
        this.draftSeq++;
        await saveDraft(null);
        await reloadJobs();
        closeOverlay(p.overlay);
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
      .child(label("Title"))
      .child(Input.new(this.title).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8))
      .child(label("Prompt"))
      .child(Textarea.new(this.prompt).w_full().h(150).p(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8))
      .child(label("Repository (runs in a new worktree)"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(this.repo ? t.foreground : t.dim)
          .child(this.repo || "Choose a folder"))
        .child(button(t, "pick-repo", "Choose…", "secondary", (_e, cx) => cx.spawn(async (cx) => {
          const folder = await pickFolder({ prompt: "Use this repository" });
          if (folder) { this.repo = folder; this.keepDraft(cx); cx.notify(); }
        }))))
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
      .child(label("When it's done"))
      .child(h_flex().gap(6).children(["off", "review", "merge"].map((m) => chip(t, `addpr-${m}`, PR_MODE_TEXT[m],
        this.prMode === m, (_e, cx) => { this.prMode = m; this.keepDraft(cx); cx.notify(); },
        m === "off" ? null : `Open a PR, then address review comments (up to ${MAX_ROUNDS} rounds)${m === "merge" ? " and merge it on a 👍" : ""}.`))))
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
    return this.renderSidebar(t);
  }
}
