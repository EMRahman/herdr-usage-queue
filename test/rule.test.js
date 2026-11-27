import { describe, expect, test } from "bun:test";
import { DAY, HOUR, judgePool, poolsFromReport, windowKind } from "../herdr-app/mods/usage-queue/rule.js";

// The design doc's example: 2026-11-26 22:52 UTC.
const NOW = Date.parse("2026-11-26T22:52:00Z");
const at = (ms) => new Date(NOW + ms).toISOString();

const REPORT = {
  timestamp: NOW,
  claude: {
    plan: "pro",
    windows: [
      { label: "5h session", used_percent: 9, resets_at: at(4.1 * HOUR) },
      { label: "7d weekly", used_percent: 96, resets_at: at(4.1 * HOUR) },
    ],
  },
  codex: {
    plan: "plus",
    windows: [
      { label: "5h session", used_percent: 100, resets_at: at(1.6 * HOUR) },
      { label: "Weekly", used_percent: 46, resets_at: at(5.7 * DAY) },
    ],
  },
  antigravity: {
    account: "default",
    groups: [
      {
        name: "Gemini Models", models: "Gemini 4 Neon, Gemini 3.8 Flash",
        buckets: [
          { label: "Weekly Limit Remaining", remaining_percent: 68, resets_at: at(6.4 * DAY) },
          { label: "Five Hour Limit Remaining", remaining_percent: 74, resets_at: at(1.4 * HOUR) },
        ],
      },
      {
        name: "Claude and GPT models", models: "Claude Opus 5.5, Claude Sonnet 5.5",
        buckets: [
          { label: "Weekly Limit Remaining", remaining_percent: 50, resets_at: at(6.4 * DAY) },
          { label: "Five Hour Limit Remaining", remaining_percent: 100, resets_at: null },
        ],
      },
    ],
  },
  read_at: { claude: NOW, codex: NOW, antigravity: NOW },
  ttl: { claude: 180000, codex: 3600000, antigravity: 3600000 },
};

const pools = poolsFromReport(REPORT);
const judge = (id, now = NOW) => judgePool(pools.find((p) => p.id === id), now);

describe("windowKind", () => {
  test("reads the providers' labels", () => {
    expect(windowKind("5h session")).toBe("5h");
    expect(windowKind("Five Hour Limit Remaining")).toBe("5h");
    expect(windowKind("7d weekly")).toBe("weekly");
    expect(windowKind("Weekly Limit Remaining")).toBe("weekly");
    expect(windowKind("month")).toBe("monthly");
    expect(windowKind("7d Opus")).toBe("weekly");
    expect(windowKind("credits")).toBe("other");
  });
});

describe("poolsFromReport", () => {
  test("one pool per account and per Antigravity group", () => {
    expect(pools.map((p) => p.id)).toEqual(["claude", "codex", "antigravity/gemini-models", "antigravity/claude-and-gpt-models"]);
    expect(pools[2].models).toEqual(["Gemini 4 Neon", "Gemini 3.8 Flash"]);
    expect(pools[0].windows[1]).toMatchObject({ kind: "weekly", leftPct: 4 });
  });

  test("an empty or missing report gives no pools", () => {
    expect(poolsFromReport(null)).toEqual([]);
    expect(poolsFromReport({})).toEqual([]);
  });
});

describe("judgePool on the design doc's example", () => {
  test("Claude is red: the weekly window is below its reserve", () => {
    const j = judge("claude");
    expect(j.light).toBe("red");
    expect(j.reason).toContain("7d weekly: 4% left, reserve 15%");
  });

  test("Codex is red: the 5h window is empty", () => {
    expect(judge("codex").light).toBe("red");
  });

  test("Antigravity Gemini is not green: a 5h leftover isn't waste while the week is behind pace", () => {
    const j = judge("antigravity/gemini-models");
    expect(j.light).toBe("yellow");
    expect(j.waste).toBe(0);
  });

  test("a window with no reset time doesn't bound the waste", () => {
    const j = judge("antigravity/claude-and-gpt-models");
    expect(j.light).toBe("yellow");
    expect(j.binding.kind).toBe("weekly");
  });
});

describe("judgePool", () => {
  const pool = (windows, extra = {}) => ({ id: "p", windows, readAt: NOW, ttl: 180000, ...extra });
  const w = (kind, leftPct, msToReset, lengthMs) => ({ kind, label: kind, leftPct, resetsAt: NOW + msToReset, lengthMs });

  test("green when every window is 20+ points under pace", () => {
    // 5h: 2h left of 5h (40% time), 90% left → +50. Weekly: 2 days left (≈29%), 70% left → +41.
    const j = judgePool(pool([w("5h", 90, 2 * HOUR, 5 * HOUR), w("weekly", 70, 2 * DAY, 7 * DAY)]), NOW);
    expect(j.light).toBe("green");
    expect(Math.round(j.waste)).toBe(41);
    expect(j.binding.kind).toBe("weekly");
  });

  test("yellow when the week is on pace even with an idle 5h window", () => {
    const j = judgePool(pool([w("5h", 100, 1 * HOUR, 5 * HOUR), w("weekly", 60, 4 * DAY, 7 * DAY)]), NOW);
    expect(j.light).toBe("yellow");
  });

  test("green just before a reset when the leftover covers a job", () => {
    // Weekly resets in 30 min with 25% left: 25 − 0.3 ≈ 24.7 spare; 5h idle.
    const j = judgePool(pool([w("weekly", 25, 30 * 60_000, 7 * DAY)]), NOW);
    expect(j.light).toBe("green");
  });

  test("red when only a sliver is above the reserve", () => {
    const j = judgePool(pool([w("5h", 28, 2 * HOUR, 5 * HOUR)]), NOW);
    expect(j.light).toBe("red");
    expect(j.changesAt).toBe(NOW + 2 * HOUR);
  });

  test("red when the reading is stale", () => {
    const j = judgePool(pool([w("5h", 90, 2 * HOUR, 5 * HOUR)], { readAt: NOW - 2 * HOUR }), NOW);
    expect(j.light).toBe("red");
    expect(j.reason).toContain("stale");
  });
});
