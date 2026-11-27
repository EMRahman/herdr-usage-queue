// GitHub through the `gh` CLI, run in a job's worktree (gh finds the repo from its remote).

import { exec } from "herdr";
import { readPR } from "./review.js";

async function gh(cwd, args, timeout = 60_000) {
  const r = await exec("gh", args, { cwd, timeout });
  return { ok: r.code === 0, out: r.stdout, err: r.stderr.trim().split("\n").at(-1) ?? "" };
}

async function json(cwd, args) {
  const r = await gh(cwd, args);
  if (!r.ok) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${r.err || "failed"}`);
  return JSON.parse(r.out || "null");
}

let login = null;

/** Your GitHub login: the agent posts as you, so your comments aren't review feedback. */
export async function myLogin(cwd) {
  login ??= (await json(cwd, ["api", "user"]))?.login ?? null;
  return login;
}

/** The PR opened from this branch, or null. */
export async function findPR(cwd, branch) {
  const list = await json(cwd, ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,state", "--limit", "1"]);
  return list?.[0] ?? null;
}

/** The PR's state, reactions, comments and reviews. */
export async function fetchPR(cwd, number) {
  const api = (path) => json(cwd, ["api", `repos/{owner}/{repo}/${path}?per_page=100`]);
  const [view, reactions, issueComments, reviews, inline] = await Promise.all([
    json(cwd, ["pr", "view", String(number), "--json", "state,url"]),
    api(`issues/${number}/reactions`),
    api(`issues/${number}/comments`),
    api(`pulls/${number}/reviews`),
    api(`pulls/${number}/comments`),
  ]);
  return readPR({ view, reactions, issueComments, reviews, inline });
}

/** Merges the PR the way the repo allows: squash, else a merge commit, else rebase. */
export async function mergePR(cwd, number) {
  const repo = await json(cwd, ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
  const how = repo?.squashMergeAllowed ? "--squash" : repo?.mergeCommitAllowed ? "--merge" : "--rebase";
  const r = await gh(cwd, ["pr", "merge", String(number), how], 120_000);
  if (!r.ok) throw new Error(r.err || "gh pr merge failed.");
  return how.slice(2);
}
