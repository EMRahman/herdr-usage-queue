// Running things: the estimate (a one-shot, read-only big-model call) and the launch (a new
// worktree with the agent in a background space).

import { appHome, exec, readTextFile, run } from "herdr";
import { estimateArgv, launchArgv } from "./catalog.js";
import { resolveBase } from "./base.js";
import { answerText, estimatePrompt, parseEstimate } from "./estimate.js";
import { expandHome, writeEstimateLog } from "./store.js";
import { stamp } from "./time.js";

const lastLine = (text) => String(text ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

const FILE_LIST = 150;
const README_LINES = 40;

/** What the estimator gets to know about the repo: its files and the top of its README. */
export async function repoSummary(repo) {
  const cwd = expandHome(repo);
  let files = [];
  try {
    const listed = await exec("git", ["ls-files"], { cwd, timeout: 15_000 });
    files = listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
    if (!files.length) files = (await exec("ls", ["-1"], { cwd, timeout: 15_000 })).stdout.split("\n").filter(Boolean);
  } catch {
    return "";
  }
  const parts = [`Files (${files.length}${files.length > FILE_LIST ? `, first ${FILE_LIST}` : ""}):`, ...files.slice(0, FILE_LIST)];
  const readme = files.find((f) => /^readme(\.\w+)?$/i.test(f));
  if (readme) {
    const text = await readTextFile(`${cwd}/${readme}`).catch(() => null);
    if (text) parts.push("", `Top of ${readme}:`, ...text.split("\n").slice(0, README_LINES));
  }
  return parts.join("\n");
}

/** The prompt an estimate sends: shown in the dialog before and after a run. */
export async function buildEstimatePrompt(job, catalog, lights) {
  return estimatePrompt(job, catalog, lights, await repoSummary(job.repo));
}

/**
 * Runs the estimate with one big model in the job's repo. Every run is logged (prompt, reply,
 * errors). Resolves with { estimate, reply, log }; rejects with an Error carrying reply and log.
 */
export async function runEstimate({ job, catalog, agent, model, effort, prompt }) {
  const argv = estimateArgv(agent, model, effort, prompt);
  const started = Date.now();
  let result;
  try {
    result = await exec(argv[0], argv.slice(1), { cwd: expandHome(job.repo), timeout: 600_000 });
  } catch (e) {
    result = { code: -1, stdout: "", stderr: String(e?.message ?? e) };
  }
  const reply = answerText(result.stdout);
  const log = await writeEstimateLog(job.id, [
    `Estimate for ${job.id} with ${agent.name} ${model} (${effort}), ${Math.round((Date.now() - started) / 1000)}s, exit ${result.code}`,
    `Command: ${argv.slice(0, -1).join(" ")} <prompt>`,
    "", "--- Prompt", prompt,
    "", "--- Reply", reply,
    "", "--- Output", result.stdout,
    "", "--- Errors", result.stderr,
  ].join("\n")).catch(() => null);
  const fail = (message) => Object.assign(new Error(message), { reply, stderr: result.stderr, log });
  if (result.code !== 0) {
    throw fail(`${agent.name} exited with ${result.code}: ${lastLine(result.stderr) || lastLine(result.stdout)}`);
  }
  try {
    return { estimate: parseEstimate(result.stdout, catalog, job.agents), reply, log };
  } catch (e) {
    // An empty reply usually comes with the CLI's reason on stderr (a denied tool, say).
    const why = !reply.trim() && lastLine(result.stderr) ? ` ${agent.name} said: ${lastLine(result.stderr)}` : "";
    throw fail(`${e.message}${why}`);
  }
}

async function git(cwd, args, timeout = 30_000) {
  const r = await exec("git", args, { cwd, timeout });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

// Herdr's worktree setting, as the shipped worktree mod reads it.
async function worktreeRoot() {
  const raw = await readTextFile(`${appHome()}/settings.json`);
  let directory = "~/.herdr/worktrees";
  try { directory = JSON.parse(raw ?? "{}")?.worktrees?.directory || directory; } catch {}
  return expandHome(directory).replace(/\/+$/, "");
}

/**
 * Makes a worktree on a new branch from the job's base (by default the remote's latest default
 * branch, fetched now) and starts the agent there with the job's prompt as its first message, in
 * a new space that doesn't take focus. Resolves with { branch, folder, argv, base }.
 */
export async function launchJob({ job, agent, model, effort }) {
  const repo = expandHome(job.repo);
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`${job.repo} isn't a git repository.`);
  const common = await git(top.out, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // The main checkout's folder names the repo, even when the job points at a worktree.
  const main = common.ok ? common.out.replace(/\/\.git\/?$/, "") : top.out;
  const name = main.split("/").filter(Boolean).at(-1);
  const branch = `queue/${job.id}-${stamp()}`;
  const folder = `${await worktreeRoot()}/${name}/${branch.replace(/\//g, "-")}`;
  const base = await resolveBase((args, timeout) => git(top.out, args, timeout), job.base);
  const add = await git(top.out, ["worktree", "add", "-b", branch, folder, base.commit], 600_000);
  if (!add.ok) throw new Error(add.err || "git worktree add failed.");
  const argv = launchArgv(agent, model, effort);
  run("space.new", { folder, argv, task: job.prompt, focus: false });
  return { branch, folder, argv, base };
}
