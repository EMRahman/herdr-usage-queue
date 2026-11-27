// After a launch: the pull request and its review rounds. Pure: GitHub's answers in, the next
// step out. The queue polls GitHub itself (cheap) and messages the agent only when there's work.
//
// Approval ("👍"), any of: a 👍 reaction on the PR, an approving review, or a comment saying
// "Didn't find any major issues" (Codex's review receipt). Feedback: inline review comments,
// change requests, and other people's comments, minus your own (the agent posts as you) and
// Codex's summary and receipts.

export const MAX_ROUNDS = 3;
const PR_MODES = ["off", "review", "merge"];
const NO_ISSUES = /didn['’]t find any major issues/i;
const CODEX_SUMMARY = /codex-pull-request-review-summary/;

/** The job file's "pr": "off" (default), "review" (open a PR and address reviews), or "merge"
 *  (and merge it on 👍). */
export function prModeOf(raw) {
  return PR_MODES.includes(raw?.pr) ? raw.pr : "off";
}

const time = (s) => Date.parse(s ?? "") || 0;

/** GitHub's REST answers (reactions, issue comments, reviews, inline comments) and the PR's
 *  state, as one PR. */
export function readPR({ view, reactions, issueComments, reviews, inline }) {
  return {
    state: view?.state ?? "OPEN",
    url: view?.url ?? "",
    reactions: (reactions ?? []).map((r) => ({ content: r.content, user: r.user?.login ?? "", at: time(r.created_at) })),
    issueComments: (issueComments ?? []).map((c) => ({ id: `c${c.id}`, user: c.user?.login ?? "", body: c.body ?? "", at: time(c.created_at) })),
    reviews: (reviews ?? []).map((r) => ({ id: `r${r.id}`, user: r.user?.login ?? "", state: r.state, body: r.body ?? "", at: time(r.submitted_at) })),
    inline: (inline ?? []).map((c) => ({
      id: `i${c.id}`, user: c.user?.login ?? "", body: c.body ?? "", at: time(c.created_at),
      path: c.path ?? "", line: c.line ?? c.original_line ?? null, replyTo: c.in_reply_to_id ?? null,
    })),
  };
}

/** When the PR last got a 👍, or 0. */
export function approvedAt(pr) {
  return Math.max(0,
    ...pr.reactions.filter((r) => r.content === "+1").map((r) => r.at),
    ...pr.reviews.filter((r) => r.state === "APPROVED").map((r) => r.at),
    ...pr.issueComments.filter((c) => NO_ISSUES.test(c.body)).map((c) => c.at));
}

/** Feedback not handled yet and not yours. */
export function newFeedback(pr, me, handled) {
  const seen = new Set(handled ?? []);
  const others = (x) => x.user !== me && !seen.has(x.id);
  return [
    ...pr.inline.filter((c) => others(c) && !c.replyTo),
    ...pr.reviews.filter((r) => others(r) && r.state === "CHANGES_REQUESTED" && r.body.trim()),
    ...pr.issueComments.filter((c) => others(c) && !NO_ISSUES.test(c.body) && !CODEX_SUMMARY.test(c.body) && c.body.trim()),
  ].sort((a, b) => a.at - b.at);
}

/**
 * The next step for a PR under review.
 * watch: { mode: "review" | "merge", rounds, handled, sentAt } (sentAt: when the last round went
 * to the agent, or 0). agentIdle: the agent can take a message now.
 * Returns { action, items }: "merged" / "closed" (it's over), "merge" (👍 in merge mode),
 * "approved" (👍 in review mode), "address" (send these items as the next round),
 * "needs-you" (new feedback after the last round), or "wait".
 */
export function reviewStep(pr, watch, me, agentIdle) {
  if (pr.state === "MERGED") return { action: "merged", items: [] };
  if (pr.state === "CLOSED") return { action: "closed", items: [] };
  const items = newFeedback(pr, me, watch.handled);
  const approved = approvedAt(pr);
  // A 👍 counts once the latest round has been sent, and when nothing newer asks for changes.
  if (approved && approved > (watch.sentAt ?? 0) && !items.some((x) => x.at > approved)) {
    return { action: watch.mode === "merge" ? "merge" : "approved", items: [] };
  }
  if (!items.length) return { action: "wait", items: [] };
  if ((watch.rounds ?? 0) >= MAX_ROUNDS) return { action: "needs-you", items };
  return { action: agentIdle ? "address" : "wait", items };
}

const clip = (text, n) => {
  const t = String(text).replace(/<!--[\s\S]*?-->/g, "").replace(/\*\*<sub>.*?<\/sub>\*\*/g, "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The message that hands a review round to the agent. */
export function roundMessage({ round, number, url, branch, items, mode }) {
  const lines = items.map((x) => `- ${x.path ? `${x.path}${x.line ? `:${x.line}` : ""} ` : ""}(${x.user}): ${clip(x.body, 700)}`);
  return [
    `Review round ${round} of ${MAX_ROUNDS} on PR #${number} (${url}). Address these comments:`,
    ...lines,
    "",
    `Fix what's right, and reply on the PR to anything you disagree with. Commit and push to ${branch},`,
    `then comment "@codex review" on the PR.${mode === "merge" ? " Don't merge it: the queue merges it on a 👍." : " Don't merge it."}`,
  ].join("\n");
}

/** `hc send`'s arguments for handing a round to an agent that isn't working. `--if` only knows
 *  "idle" and "working", and an agent sits at "done" after a turn until you look at it, so a
 *  "done" agent is sent to without the guard (the watcher already saw it wasn't working). */
export function sendArgs(terminal, status, message) {
  return ["send", ...(status === "idle" ? ["--if", "idle"] : []), terminal, message];
}

/** What the launch adds to the job's prompt when a PR is wanted. */
export function prInstructions({ branch, baseBranch, mode }) {
  return [
    "",
    "---",
    `When the work is done: commit it, push branch ${branch}, and open a pull request${baseBranch ? ` against ${baseBranch}` : ""}`,
    "with `gh pr create`, with a clear title and a short summary of what changed and how you checked it.",
    `Then stop: don't merge it${mode === "merge" ? " (the queue merges it on a 👍)" : ""}. If reviewers comment, you'll get them here.`,
  ].join("\n");
}
