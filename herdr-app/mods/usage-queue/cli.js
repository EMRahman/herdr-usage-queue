#!/usr/bin/env bun
// Usage Queue from the command line, for you or a coding agent. Not part of the mod's view: Herdr
// starts main.js; install.ts copies this file beside it so it can reuse the pure modules.
//
//   bun cli.js add --prompt "…" [--title …] [--repo .] [--after <id>] …   queue a job
//   bun cli.js list [--json]                                               every job and where it is
//   bun cli.js status <id> [--json]                                        one job, with its history
//   bun cli.js validate [<id or file>…] [--json]                           check job files
//
// It writes only new job files (atomically, so the mod's folder watcher never sees half a file)
// and reads state.json and history/. Allocating and launching stay with you, in the queue.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentOf, mergeCatalog, modelOf, PERMISSION_PROFILES, supportsPermissions } from "./catalog.js";
import { allocationFor, blockedBy, isFinished, jobId, readJob, waitFor } from "./queue.js";

// --- Pure: checking a job file, and saying where a job is ---

/** The fields the mod reads. */
export const KNOWN_FIELDS = new Set(["about", "title", "prompt", "where", "repo", "agents", "model", "effort",
  "priority", "launch", "pr", "base", "permissions", "after"]);
/** In DESIGN.md but not built: the mod ignores them. */
export const NOT_YET = new Set(["repeat", "deadline", "maxMinutes"]);
const PR_MODES = ["off", "review", "merge"];

/**
 * A job file checked the way the mod reads it, plus what the mod would silently ignore or get
 * stuck on. `jobs` are the other jobs (readJob output), `state` is state.json.
 * Returns { job, errors, warnings }: errors mean the job can't be read, can't run, or waits forever.
 */
export function checkJob(id, text, { jobs = [], state = { jobs: {} }, catalog = mergeCatalog(null), repoExists = null } = {}) {
  const errors = [], warnings = [];
  const { job, error } = readJob(id, text);
  if (error) return { job: null, errors: [error], warnings };
  const raw = job.raw;

  for (const key of Object.keys(raw)) {
    if (NOT_YET.has(key)) warnings.push(`"${key}" isn't built yet; the queue ignores it.`);
    else if (!KNOWN_FIELDS.has(key)) warnings.push(`"${key}" isn't a job field; the queue ignores it.`);
  }
  if (raw.where && typeof raw.where === "object" && !raw.where.worktree) {
    warnings.push(`Only "where": { "worktree": … } is built; ${Object.keys(raw.where).join(", ")} is ignored.`);
  }
  if (repoExists && !repoExists(job.repo)) errors.push(`The repository ${job.repo} isn't a git checkout on this machine.`);

  for (const agentId of job.agents) {
    if (agentId.includes(":")) errors.push(`"${agentId}": pinning a pool (account) isn't built yet; use the agent id ("${agentId.split(":")[0]}").`);
    else if (!agentOf(catalog, agentId)) errors.push(`Unknown agent "${agentId}". Known: ${catalog.agents.map((a) => a.id).join(", ")}.`);
  }
  for (const [agentId, model] of Object.entries(job.model)) {
    const agent = agentOf(catalog, agentId);
    if (!job.agents.includes(agentId)) warnings.push(`"model" names ${agentId}, which isn't in "agents".`);
    else if (agent && !modelOf(agent, model)) errors.push(`${agent.name} has no model "${model}". Known: ${agent.models.map((m) => m.id).join(", ")}.`);
    if (!(agentId in job.effort)) warnings.push(`"model" for ${agentId} has no "effort"; both are needed to prefill the allocation.`);
  }
  for (const [agentId, effort] of Object.entries(job.effort)) {
    const agent = agentOf(catalog, agentId);
    if (agent && !agent.efforts.includes(effort)) errors.push(`${agent.name} has no effort "${effort}". Known: ${agent.efforts.join(", ")}.`);
  }
  const unsupported = job.agents.map((a) => agentOf(catalog, a)).filter((a) => a && !supportsPermissions(a, job.permissions));
  if (unsupported.length) {
    const msg = `${unsupported.map((a) => a.name).join(", ")} can't run the ${PERMISSION_PROFILES[job.permissions].label} profile.`;
    (unsupported.length === job.agents.length ? errors : warnings).push(msg);
  }
  if (raw.priority !== undefined && !Number.isInteger(raw.priority)) warnings.push(`"priority" must be a whole number; using 3.`);
  if (raw.launch !== undefined && raw.launch !== "auto" && raw.launch !== "approve") warnings.push(`"launch" is "approve" or "auto"; using "approve".`);
  if (raw.pr !== undefined && !PR_MODES.includes(raw.pr)) warnings.push(`"pr" is ${PR_MODES.join(", ")}; using "off".`);

  if (job.after) {
    const others = jobs.filter((j) => j.id !== id);
    if (job.after === id) warnings.push(`"after" names this job itself; it's ignored.`);
    else if (!others.some((j) => j.id === job.after)) {
      if (state.deleted?.[job.after]) warnings.push(`"after": ${job.after} was deleted, so this job doesn't wait.`);
      else errors.push(`"after": no job named ${job.after}. The job would wait until one turns up.`);
    } else if (waitsOn(job.after, id, [...others, job], state)) {
      errors.push(`"after": ${job.after} waits (directly or further down) for this job: a loop, so neither would launch.`);
    }
  }
  return { job, errors, warnings };
}

/** Whether `from`'s chain of waits reaches `target`. */
function waitsOn(from, target, jobs, state) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const seen = new Set();
  for (let id = from; id && !seen.has(id); ) {
    if (id === target) return true;
    seen.add(id);
    const job = byId.get(id);
    id = job ? waitFor(job, state) : null;
  }
  return false;
}

/** Where a job is, in the queue's words: { phase, text }. Allowance isn't read here; the sidebar
 *  shows it. phase: needs-allocation | saved | auto | waiting | working | braked | pr | needs-you | done */
export function statusOf(job, jobs, state) {
  const s = state.jobs?.[job.id] ?? {};
  const allocation = allocationFor(job, state);
  const launched = allocation && s.launched?.hash === job.hash ? s.launched : null;
  if (launched) {
    const w = launched.pr && launched.pr.mode !== "off" ? launched.pr : null;
    if (isFinished(s)) {
      if (launched.markedFinishedAt) return { phase: "done", text: "Finished (marked by you)" };
      return { phase: "done", text: w ? `Merged #${w.number}` : "Done: the agent finished" };
    }
    if (launched.braked) return { phase: "braked", text: `Braked: ${launched.braked.reason ?? "allowance at the reserve"}` };
    if (w?.phase === "needs-you" || w?.phase === "closed" || w?.phase === "ended") {
      return { phase: "needs-you", text: w.phase === "closed" ? `PR #${w.number} closed` : w.phase === "ended" ? "Stopped watching its PR" : `PR #${w.number} needs you` };
    }
    if (w?.number) return { phase: "pr", text: w.phase === "approved" ? `PR #${w.number} approved: merge it` : `PR #${w.number}${w.rounds ? ` · review round ${w.rounds}` : ""}` };
    return { phase: "working", text: "Working" };
  }
  const wait = blockedBy(job, jobs, state);
  if (wait) return { phase: "waiting", text: `Waits for ${wait.job.id}, which ${wait.why}` };
  if (!allocation) return { phase: "needs-allocation", text: "Needs allocation: open it in the queue to size and launch it" };
  if (allocation.auto) return { phase: "auto", text: state.paused ? "Auto, but auto launches are paused" : "Auto: launches when there's allowance" };
  return { phase: "saved", text: "Allocation saved: launch it from the queue" };
}

// --- Files ---

/** The Herdr app's home: $HERDR_APP_HOME, else the one this file is installed in, else ~/.config/herdr-app. */
export function appHome(env = process.env, here = import.meta.dir) {
  if (env.HERDR_APP_HOME) return resolve(env.HERDR_APP_HOME);
  const installed = resolve(here, "..", "..");
  if (basename(dirname(here)) === "mods" && existsSync(join(installed, "layouts"))) return installed;
  return join(homedir(), ".config", "herdr-app");
}

const expandHome = (p) => (p === "~" || p?.startsWith("~/") ? homedir() + p.slice(1) : p);
const tilde = (p) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);
const readJSON = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };

function loadAll(base) {
  const state = readJSON(join(base, "state.json"), { jobs: {} });
  if (!state.jobs) state.jobs = {};
  const catalog = mergeCatalog(readJSON(join(base, "catalog.json"), null));
  const dir = join(base, "jobs");
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
  const jobs = [], problems = [], texts = new Map();
  for (const name of files) {
    const id = name.slice(0, -5);
    const text = readFileSync(join(dir, name), "utf8");
    texts.set(id, text);
    const { job, error } = readJob(id, text);
    if (error) { problems.push({ id, error }); continue; }
    job.hash = hashText(text);
    job.createdAt = state.jobs[id]?.createdAt ?? 0;
    jobs.push(job);
  }
  return { state, catalog, jobs, problems, texts, dir };
}

// Same as store.js's hashText (which imports Herdr, so it can't be used here).
function hashText(text) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 16);
}

/** The main checkout of the git repo at `path` (not a worktree of it, which the queue may remove), or null. */
function mainCheckout(path) {
  const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return null;
  const common = r.stdout.toString().trim();
  if (basename(common) === ".git") return dirname(common);
  const top = Bun.spawnSync(["git", "-C", path, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return top.exitCode === 0 ? top.stdout.toString().trim() : null;
}
const isRepo = (repo) => existsSync(expandHome(repo)) && mainCheckout(expandHome(repo)) !== null;

function history(base, id, days = 14) {
  const dir = join(base, "history");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().slice(-days);
  const events = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e.job === id) events.push(e); } catch {}
    }
  }
  return events;
}

// --- Commands ---

const HELP = `Usage Queue: queue coding-agent jobs to run when there's allowance.

  add       Queue a job. It appears in the queue as "Needs allocation"; you launch it there.
            --prompt <text> | --prompt-file <path> | --prompt -   (stdin)     required
            --title <text>        short title (default: the prompt's first line)
            --repo <path>         git repo (default: the one you're in; its main checkout)
            --agents claude,codex agents that may do it (default: claude)
            --model claude=sonnet --effort claude=medium   prefill the allocation (repeatable)
            --priority <1..>      1 = highest (default 3)
            --permissions default|plan|edit
            --pr off|review|merge open a PR; review: address reviews; merge: and merge on 👍
            --base remote|local|<branch>   what it starts from (default remote)
            --after <id>          wait for that job to finish first
            --auto                turn on Auto when you save the allocation
            --id <id>             file name (default: from the title, plus the time)
            --dry-run             check and print the file without writing it
  list      Every job and where it is.
  status    <id>: one job, its allocation, launch, PR and recent history.
  validate  [<id or file>…]: check job files (default: all). Exits 1 on errors.

  --json on any command prints JSON. Jobs live in <app home>/usage-queue/jobs/
  (app home: $HERDR_APP_HOME, else ~/.config/herdr-app).`;

class UsageError extends Error {}

function pairs(list, flag) {
  const out = {};
  for (const item of list ?? []) {
    const [k, v] = item.split("=");
    if (!k || !v) throw new UsageError(`--${flag} takes agent=value, like claude=sonnet.`);
    out[k.trim()] = v.trim();
  }
  return out;
}

function readPrompt(v) {
  if (v.prompt === "-" || v["prompt-file"] === "-") return readFileSync(0, "utf8");
  if (v["prompt-file"]) return readFileSync(resolve(expandHome(v["prompt-file"])), "utf8");
  return v.prompt ?? "";
}

/** The job file's object from add's options. */
export function jobFromOptions(v, prompt, repo) {
  const agents = (v.agents ?? "claude").split(",").map((a) => a.trim()).filter(Boolean);
  const model = pairs(v.model, "model"), effort = pairs(v.effort, "effort");
  const raw = { about: v.title?.trim() || undefined, prompt: prompt.trim(), where: { worktree: { repo } }, agents };
  if (Object.keys(model).length) raw.model = model;
  if (Object.keys(effort).length) raw.effort = effort;
  raw.priority = v.priority === undefined ? 3 : Number(v.priority);
  raw.launch = v.auto ? "auto" : "approve";
  raw.pr = v.pr ?? "off";
  if (v.permissions && v.permissions !== "default") raw.permissions = v.permissions;
  if (v.base && v.base !== "remote") raw.base = v.base;
  if (v.after) raw.after = v.after;
  return JSON.parse(JSON.stringify(raw));
}

function add(v, base, out) {
  const prompt = readPrompt(v);
  if (!prompt.trim()) throw new UsageError("add needs a prompt: --prompt, --prompt-file or --prompt - (stdin).");
  const repoArg = resolve(expandHome(v.repo ?? "."));
  const repo = mainCheckout(repoArg);
  if (!repo) throw new UsageError(`${repoArg} isn't in a git repository. Pass --repo <path>.`);
  const { state, catalog, jobs, dir } = loadAll(base);
  const raw = jobFromOptions(v, prompt, tilde(repo));
  const title = raw.about ?? prompt.trim().split("\n")[0].slice(0, 120);
  const id = v.id ?? jobId(title);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new UsageError(`--id may use letters, digits, ".", "_" and "-".`);
  const text = JSON.stringify(raw, null, 2) + "\n";
  const { errors, warnings } = checkJob(id, text, { jobs, state, catalog });
  if (existsSync(join(dir, `${id}.json`))) errors.push(`There's already a job named ${id}.`);
  const file = join(dir, `${id}.json`);
  if (!errors.length && !v["dry-run"]) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.json.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  const written = !errors.length && !v["dry-run"];
  if (v.json) out(JSON.stringify({ id, file, written, errors, warnings, job: raw }, null, 2));
  else {
    for (const w of warnings) out(`warning: ${w}`);
    for (const e of errors) out(`error: ${e}`);
    if (v["dry-run"]) out(text.trimEnd());
    if (written) out(`Queued ${id}\n  ${tilde(file)}\n  It shows in Usage Queue as "Needs allocation"${raw.after ? `, after ${raw.after}` : ""}. Size and launch it there${raw.launch === "auto" ? " (Auto turns on when you save the allocation)" : ""}.`);
  }
  return errors.length ? 1 : 0;
}

function list(v, base, out) {
  const { state, jobs, problems } = loadAll(base);
  const rows = jobs.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((job) => ({ id: job.id, title: job.title, priority: job.priority, after: waitFor(job, state) ?? null, repo: job.repo, ...statusOf(job, jobs, state) }));
  if (v.json) { out(JSON.stringify({ jobs: rows, problems }, null, 2)); return 0; }
  if (!rows.length && !problems.length) out("No jobs. Add one with: add --prompt \"…\"");
  for (const r of rows) out(`${r.id}\n  ${r.title}\n  ${r.text}`);
  for (const p of problems) out(`${p.id}\n  can't be read: ${p.error}`);
  return 0;
}

function status(v, ids, base, out) {
  if (ids.length !== 1) throw new UsageError("status takes one job id (see list).");
  const id = ids[0].replace(/\.json$/, "");
  const { state, jobs, problems } = loadAll(base);
  const job = jobs.find((j) => j.id === id);
  if (!job) {
    const problem = problems.find((p) => p.id === id);
    const why = problem ? `can't be read: ${problem.error}` : state.deleted?.[id] ? "was deleted" : "doesn't exist";
    if (v.json) out(JSON.stringify({ id, error: why }, null, 2)); else out(`${id} ${why}.`);
    return 1;
  }
  const s = state.jobs[id] ?? {};
  const allocation = allocationFor(job, state);
  const launched = allocation && s.launched?.hash === job.hash ? s.launched : null;
  const events = history(base, id).slice(-10);
  const result = {
    id, title: job.title, repo: job.repo, agents: job.agents, priority: job.priority, after: waitFor(job, state) ?? null,
    ...statusOf(job, jobs, state),
    allocation: allocation ? { ...allocation.route, auto: Boolean(allocation.auto), pr: allocation.pr ?? job.pr } : null,
    launched: launched ? { at: launched.at, branch: launched.branch, folder: launched.folder, pr: launched.pr ?? null } : null,
    history: events,
  };
  if (v.json) { out(JSON.stringify(result, null, 2)); return 0; }
  out(`${job.title}  (${id})\n  ${result.text}`);
  out(`  repo ${job.repo} · ${job.agents.join(", ")} · priority ${job.priority}${result.after ? ` · after ${result.after}` : ""}`);
  if (result.allocation) out(`  allocation: ${result.allocation.agent} · ${result.allocation.model} · ${result.allocation.effort}${result.allocation.auto ? " · Auto" : ""}`);
  if (launched) out(`  launched ${new Date(launched.at).toLocaleString()} on ${launched.branch} in ${tilde(launched.folder ?? "")}`);
  if (launched?.pr?.number) out(`  PR #${launched.pr.number}${launched.pr.url ? ` ${launched.pr.url}` : ""}`);
  if (events.length) out(`  history:\n${events.map((e) => `    ${new Date(e.at).toLocaleString()}  ${e.type}`).join("\n")}`);
  return 0;
}

function validate(v, targets, base, out) {
  const { state, catalog, jobs, texts, dir } = loadAll(base);
  const items = targets.length
    ? targets.map((t) => {
      const path = t.endsWith(".json") || t.includes("/") ? resolve(expandHome(t)) : join(dir, `${t}.json`);
      return { id: basename(path, ".json"), text: existsSync(path) ? readFileSync(path, "utf8") : null, path };
    })
    : [...texts].map(([id, text]) => ({ id, text, path: join(dir, `${id}.json`) }));
  const results = items.map(({ id, text, path }) => text === null
    ? { id, file: path, errors: ["No such file."], warnings: [] }
    : (({ errors, warnings }) => ({ id, file: path, errors, warnings }))(checkJob(id, text, { jobs, state, catalog, repoExists: isRepo })));
  const failed = results.some((r) => r.errors.length);
  if (v.json) out(JSON.stringify({ ok: !failed, results }, null, 2));
  else {
    if (!results.length) out("No job files.");
    for (const r of results) {
      out(`${r.errors.length ? "✗" : "✓"} ${r.id}`);
      for (const e of r.errors) out(`    error: ${e}`);
      for (const w of r.warnings) out(`    warning: ${w}`);
    }
  }
  return failed ? 1 : 0;
}

/** Runs one command; resolves with the exit code. `out` prints a line. */
export function run(argv, { base = join(appHome(), "usage-queue"), out = console.log } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        prompt: { type: "string" }, "prompt-file": { type: "string" }, title: { type: "string" }, repo: { type: "string" },
        agents: { type: "string" }, model: { type: "string", multiple: true }, effort: { type: "string", multiple: true },
        priority: { type: "string" }, permissions: { type: "string" }, pr: { type: "string" }, base: { type: "string" },
        after: { type: "string" }, auto: { type: "boolean" }, id: { type: "string" }, "dry-run": { type: "boolean" },
        json: { type: "boolean" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    out(`${e.message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals: [command, ...rest] } = parsed;
  if (!command || v.help || command === "help") { out(HELP); return command || v.help ? 0 : 2; }
  try {
    if (command === "add") return add(v, base, out);
    if (command === "list") return list(v, base, out);
    if (command === "status") return status(v, rest, base, out);
    if (command === "validate") return validate(v, rest, base, out);
    throw new UsageError(`Unknown command ${command}.`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out(v.json ? JSON.stringify({ error: e.message }) : `${e.message}\nRun with --help for usage.`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
