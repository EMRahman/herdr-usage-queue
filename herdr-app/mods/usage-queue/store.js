// Storage: every read and write of jobs, state and history goes through here, so moving to a
// database later changes only this file.
//
//   <app home>/usage-queue/jobs/<id>.json      job definitions (you, the form, or an agent)
//   <app home>/usage-queue/state.json          each job's estimate, approval and launch (this mod only)
//   <app home>/usage-queue/history/<day>.jsonl what happened, append-only (this mod only)
//   <app home>/usage-queue/catalog.json        optional: agent and model overrides
//
// Outside mods/, because Herdr reloads a mod whenever a file in its folder changes.

import * as fs from "fs/promises";
import { createHash } from "crypto";
import { appHome, exec, home, readTextFile, setShared, shared, writeTextFile } from "herdr";
import { mergeCatalog } from "./catalog.js";
import { readJob } from "./queue.js";
import { checkIn, CONSUMERS_KEY, contractUsable, poolsFromContract, poolsFromReport, WINDOWS_KEY } from "./rule.js";
import { day } from "./time.js";

export const STATE_VERSION = 1;

export const paths = () => {
  const base = `${appHome()}/usage-queue`;
  return {
    base, jobs: `${base}/jobs`, history: `${base}/history`, state: `${base}/state.json`,
    catalog: `${base}/catalog.json`, draft: `${base}/draft.json`,
  };
};

export async function ensureFolders() {
  const p = paths();
  await fs.mkdir(p.jobs, { recursive: true });
  await fs.mkdir(p.history, { recursive: true });
}

export const hashText = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Every job file: { jobs, problems } where problems are files that couldn't be read. */
export async function loadJobs(state) {
  const dir = paths().jobs;
  let names = [];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch { return { jobs: [], problems: [] }; }
  const jobs = [], problems = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    const text = await readTextFile(`${dir}/${name}`);
    if (text === null) continue;
    const { job, error } = readJob(id, text);
    if (error) { problems.push({ id, error }); continue; }
    job.hash = hashText(text);
    job.file = `${dir}/${name}`;
    job.createdAt = state.jobs?.[id]?.createdAt ?? Date.now();
    jobs.push(job);
  }
  return { jobs, problems };
}

function parseState(text) {
  try {
    const s = JSON.parse(text);
    if (s && typeof s === "object" && s.jobs && typeof s.jobs === "object") return s;
  } catch {}
  return null;
}

export async function loadState() {
  const text = await readTextFile(paths().state);
  return (text !== null && parseState(text)) || { version: STATE_VERSION, jobs: {} };
}

/** Changes state.json: reads the file as it is now, applies `change`, writes it atomically. */
export async function updateState(change) {
  const path = paths().state;
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await readTextFile(path);
    const state = (text !== null && parseState(text)) || { version: STATE_VERSION, jobs: {} };
    change(state);
    state.version = STATE_VERSION;
    try {
      await writeTextFile(path, JSON.stringify(state, null, 2) + "\n", text);
      return state;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

/** Appends one event to today's history file. */
export async function record(event) {
  const at = Date.now();
  const path = `${paths().history}/${day(at)}.jsonl`;
  const line = JSON.stringify({ version: STATE_VERSION, at, ...event }) + "\n";
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await readTextFile(path);
    try {
      await writeTextFile(path, (text ?? "") + line, text);
      return;
    } catch (e) {
      if (attempt === 2) console.warn(`usage-queue: couldn't record ${event.type}: ${e}`);
    }
  }
}

export async function writeNewJob(id, text) {
  await ensureFolders();
  await writeTextFile(`${paths().jobs}/${id}.json`, text, null);
}

export async function deleteJob(id) {
  await fs.unlink(`${paths().jobs}/${id}.json`);
  await updateState((s) => { delete s.jobs[id]; });
}

/** Saves one estimate run's prompt and output; resolves with the file's path. */
export async function writeEstimateLog(jobId, text) {
  const dir = `${paths().base}/estimates`;
  await fs.mkdir(dir, { recursive: true });
  const path = `${dir}/${jobId}-${stampFile()}.txt`;
  await fs.writeFile(path, text);
  return path;
}

function stampFile(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${day(ms)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// --- The add form's draft: kept so Esc or a restart doesn't lose what you typed ---

export async function loadDraft() {
  const text = await readTextFile(paths().draft);
  try { return text === null ? null : JSON.parse(text); } catch { return null; }
}

/** Saves the draft, or removes it when it's null. */
export async function saveDraft(draft) {
  const path = paths().draft;
  if (draft === null) {
    if (await fs.exists(path)) await fs.unlink(path);
    return;
  }
  await ensureFolders();
  const text = await readTextFile(path);
  await writeTextFile(path, JSON.stringify(draft, null, 2) + "\n", text);
}

export async function loadCatalog() {
  const text = await readTextFile(paths().catalog);
  if (text === null) return mergeCatalog(null);
  try { return mergeCatalog(JSON.parse(text)); } catch { return mergeCatalog(null); }
}

/** "~/x" → "/Users/me/x". */
export const expandHome = (path) => (path === "~" || path?.startsWith("~/") ? home() + path.slice(1) : path);

// --- Readings: Usage Monitor's published readings, else its bridge ---

const CONSUMER_ID = "usage-queue";

/**
 * The pools to judge: Usage Monitor's published readings, else its bridge's. Throws when there
 * are none to be had.
 *
 * `fresh`: a job is scheduled, being watched, or waiting to resume. The queue checks in with
 * Usage Monitor as a consumer, so Usage Monitor keeps reading while its readout is hidden. Without
 * published readings (an older Usage Monitor, or none of its views open), it asks the bridge,
 * which refreshes only what's due.
 */
export async function readPools(fresh = false) {
  try {
    const consumers = shared(CONSUMERS_KEY);
    if (fresh || consumers?.[CONSUMER_ID]) setShared(CONSUMERS_KEY, checkIn(consumers, CONSUMER_ID, fresh));
  } catch {}
  let contract = null;
  try { contract = shared(WINDOWS_KEY); } catch {}
  if (contractUsable(contract)) return poolsFromContract(contract);
  return poolsFromReport(await readReport(fresh));
}

let bun = null;

/**
 * Usage Monitor's latest report, or throws. Cached only, unless `refresh`: then the bridge asks
 * any provider that's due under Usage Monitor's adaptive schedule (it never asks sooner).
 */
async function readReport(refresh = false) {
  const bridge = `${appHome()}/mods/usage-monitor/bridge.js`;
  if (!(await fs.exists(bridge))) throw new Error("Usage Monitor isn't installed: the queue reads allowance from it.");
  let configured = null;
  try { configured = JSON.parse(await readTextFile(`${appHome()}/mods/usage-monitor/config.json`) ?? "{}").bun; } catch {}
  const candidates = [...new Set([bun, "bun", configured, `${home()}/.bun/bin/bun`, "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
    .filter(Boolean))];
  for (const candidate of candidates) {
    const started = Date.now();
    let result;
    try {
      result = await exec(candidate, refresh ? [bridge] : [bridge, "--cached"], { timeout: 45_000 });
    } catch (failure) {
      if (Date.now() - started > 2_000) throw failure;
      continue;
    }
    bun = candidate;
    if (result.code !== 0) throw new Error(`Usage Monitor's bridge failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`);
    return JSON.parse(result.stdout).report;
  }
  throw new Error("Couldn't find Bun to read Usage Monitor's readings.");
}
