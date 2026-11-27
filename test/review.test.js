import { describe, expect, test } from "bun:test";
import {
  approvedAt, newFeedback, prInstructions, prModeOf, readPR, reviewStep, roundMessage, sendArgs,
} from "../herdr-app/mods/usage-queue/review.js";

const ME = "EMRahman";
const BOT = "chatgpt-codex-connector[bot]";
const T = (m) => `2026-11-27T10:${String(m).padStart(2, "0")}:00Z`;
const at = (m) => Date.parse(T(m));

// Shaped like GitHub's REST answers, as seen on a real PR reviewed by Codex.
const pr = (extra = {}) => readPR({
  view: { state: "OPEN", url: "https://github.com/o/r/pull/7" },
  reactions: [],
  issueComments: [
    { id: 1, user: { login: BOT }, created_at: T(1), body: "<!-- codex-pull-request-review-summary --> summary" },
  ],
  reviews: [{ id: 2, user: { login: BOT }, state: "COMMENTED", submitted_at: T(3), body: "### 💡 Codex Review\nHere are some automated review suggestions" }],
  inline: [
    { id: 3, user: { login: BOT }, created_at: T(3), path: "src/a.ts", line: 12, body: "**<sub><sub>P2</sub></sub>** Handle the empty list" },
    { id: 4, user: { login: ME }, created_at: T(5), path: "src/a.ts", line: 12, in_reply_to_id: 3, body: "Fixed" },
  ],
  ...extra,
});

describe("reviewStep", () => {
  const watch = (extra = {}) => ({ mode: "merge", rounds: 0, handled: [], sentAt: 0, ...extra });

  test("Codex's inline comments make the first round; its summary and your replies don't count", () => {
    const step = reviewStep(pr(), watch(), ME, true);
    expect(step.action).toBe("address");
    expect(step.items.map((x) => x.id)).toEqual(["i3"]);
  });

  test("waits while the agent is busy", () => {
    expect(reviewStep(pr(), watch(), ME, false).action).toBe("wait");
  });

  test("handled comments aren't sent again", () => {
    expect(reviewStep(pr(), watch({ rounds: 1, handled: ["i3"], sentAt: at(4) }), ME, true).action).toBe("wait");
  });

  test("a 👍 after the round merges; in review mode it's only approved", () => {
    const thumbs = pr({ reactions: [{ content: "+1", user: { login: BOT }, created_at: T(9) }] });
    const w = watch({ rounds: 1, handled: ["i3"], sentAt: at(4) });
    expect(reviewStep(thumbs, w, ME, true).action).toBe("merge");
    expect(reviewStep(thumbs, { ...w, mode: "review" }, ME, true).action).toBe("approved");
  });

  test("Codex's \"Didn't find any major issues\" receipt counts as a 👍", () => {
    const receipt = pr({ issueComments: [
      { id: 9, user: { login: BOT }, created_at: T(9), body: "<!-- codex-review-receipt:v1 --> Codex Review: Didn't find any major issues. Swish!" },
    ] });
    expect(approvedAt(receipt)).toBe(at(9));
    expect(reviewStep(receipt, watch({ rounds: 1, handled: ["i3"], sentAt: at(4) }), ME, true).action).toBe("merge");
  });

  test("a 👍 from before the latest round doesn't count", () => {
    const old = pr({ reactions: [{ content: "+1", user: { login: BOT }, created_at: T(2) }] });
    expect(reviewStep(old, watch({ rounds: 1, handled: ["i3"], sentAt: at(4) }), ME, true).action).toBe("wait");
  });

  test("new feedback after the third round goes to you", () => {
    expect(reviewStep(pr(), watch({ rounds: 3 }), ME, true).action).toBe("needs-you");
  });

  test("merged or closed on GitHub ends it", () => {
    expect(reviewStep(pr({ view: { state: "MERGED" } }), watch(), ME, true).action).toBe("merged");
    expect(reviewStep(pr({ view: { state: "CLOSED" } }), watch(), ME, true).action).toBe("closed");
  });

  test("change requests and other people's comments are feedback", () => {
    const p = pr({
      reviews: [{ id: 5, user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: T(6), body: "Please add tests" }],
      issueComments: [{ id: 6, user: { login: "bob" }, created_at: T(7), body: "Rename this?" }],
    });
    expect(newFeedback(p, ME, ["i3"]).map((x) => x.id)).toEqual(["r5", "c6"]);
  });
});

describe("messages", () => {
  test("a round lists each comment with where it is, cleaned of Codex's badges", () => {
    const items = newFeedback(pr(), ME, []);
    const m = roundMessage({ round: 1, number: 7, url: "u", branch: "queue/x", items, mode: "merge" });
    expect(m).toContain("Review round 1 of 3 on PR #7");
    expect(m).toContain(`- src/a.ts:12 (${BOT}): Handle the empty list`);
    expect(m).toContain('comment "@codex review"');
    expect(m).toContain("Don't merge it");
  });

  test("the launch's PR instructions", () => {
    const text = prInstructions({ branch: "queue/x", baseBranch: "main", mode: "review" });
    expect(text).toContain("push branch queue/x");
    expect(text).toContain("against main");
  });

  test("the job file's pr mode", () => {
    expect(prModeOf({})).toBe("off");
    expect(prModeOf({ pr: "merge" })).toBe("merge");
    expect(prModeOf({ pr: "yes" })).toBe("off");
  });
});

describe("sendArgs", () => {
  test("an idle agent is sent to only while it's still idle", () => {
    expect(sendArgs("t40", "idle", "hi")).toEqual(["send", "--if", "idle", "t40", "hi"]);
  });

  test("a done agent (after a turn, unseen) is sent to: hc's --if has no \"done\"", () => {
    expect(sendArgs("t40", "done", "hi")).toEqual(["send", "t40", "hi"]);
  });
});
