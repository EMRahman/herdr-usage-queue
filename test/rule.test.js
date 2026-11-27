import { describe, expect, test } from "bun:test";
import {
  checkIn, CONTRACT_FRESH_MS, contractUsable, DAY, HOUR, judgeAll, judgePool, poolsFromContract, poolsFromReport, windowKind,
} from "../herdr-app/mods/usage-queue/rule.js";

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

  test("a provider missing from read_at has an unknown reading time, not the report's save time", () => {
    const report = { ...REPORT, timestamp: NOW, read_at: { claude: NOW - 60_000 } };
    const byId = Object.fromEntries(poolsFromReport(report).map((p) => [p.id, p.readAt]));
    expect(byId.claude).toBe(NOW - 60_000);
    expect(byId.codex).toBeNull();
    // A report with no read_at at all falls back to when it was saved.
    expect(poolsFromReport({ ...REPORT, read_at: undefined, timestamp: NOW - HOUR })[0].readAt).toBe(NOW - HOUR);
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

  test("red when the reading's age is unknown", () => {
    const j = judgePool(pool([w("5h", 90, 2 * HOUR, 5 * HOUR)], { readAt: null }), NOW);
    expect(j.light).toBe("red");
    expect(j.reason).toBe("Reading age unknown");
    expect(j.reading).toBe("stale");
  });
});

// The same readings as REPORT, as Usage Monitor publishes them (its contract.js).
const contractWindow = (kind, label, leftPct, resetsAt, lengthMs) => ({ kind, label, leftPct, resetsAt, lengthMs, light: null });
const CONTRACT = {
  version: 1,
  readAt: NOW,
  checkedAt: NOW,
  pools: [
    { id: "claude", provider: "claude", account: null, plan: "pro", readAt: NOW, ttlMs: 180000, heldResets: [], windows: [
      contractWindow("5h", "5h session", 91, at(4.1 * HOUR), 5 * HOUR),
      contractWindow("weekly", "7d weekly", 4, at(4.1 * HOUR), 7 * DAY),
    ] },
    { id: "codex", provider: "codex", account: null, plan: "plus", readAt: NOW, ttlMs: 3600000, heldResets: [], windows: [
      contractWindow("5h", "5h session", 0, at(1.6 * HOUR), 5 * HOUR),
      contractWindow("weekly", "Weekly", 54, at(5.7 * DAY), 7 * DAY),
    ] },
    { id: "antigravity/gemini-models", provider: "antigravity", name: "Gemini Models", account: "default", plan: null,
      models: ["Gemini 4 Neon", "Gemini 3.8 Flash"], readAt: NOW, ttlMs: 3600000, windows: [
        contractWindow("weekly", "Weekly Limit Remaining", 68, at(6.4 * DAY), 7 * DAY),
        contractWindow("5h", "Five Hour Limit Remaining", 74, at(1.4 * HOUR), 5 * HOUR),
      ] },
    { id: "antigravity/claude-and-gpt-models", provider: "antigravity", name: "Claude and GPT models", account: "default",
      plan: null, models: ["Claude Opus 5.5", "Claude Sonnet 5.5"], readAt: NOW, ttlMs: 3600000, windows: [
        contractWindow("weekly", "Weekly Limit Remaining", 50, at(6.4 * DAY), 7 * DAY),
        contractWindow("5h", "Five Hour Limit Remaining", 100, null, 5 * HOUR),
      ] },
  ],
};

describe("Usage Monitor's published readings", () => {
  test("give the same pools as the bridge report", () => {
    expect(poolsFromContract(CONTRACT)).toEqual(poolsFromReport(REPORT));
  });

  test("so every pool is judged the same", () => {
    for (const offset of [0, 3 * HOUR, 5 * HOUR]) {
      expect(judgeAll(poolsFromContract(CONTRACT), NOW + offset)).toEqual(judgeAll(pools, NOW + offset));
    }
  });

  test("a window's own length wins over its kind's; an unknown kind is read from the label", () => {
    const [pool] = poolsFromContract({ pools: [{ id: "cursor", provider: "cursor", readAt: NOW, windows: [
      { kind: "monthly", label: "month · Auto", leftPct: 70, resetsAt: at(10 * DAY), lengthMs: 31 * DAY },
      { kind: "fortnightly", label: "Weekly", leftPct: 40, resetsAt: null, lengthMs: null },
      { kind: "5h", label: "broken", leftPct: null, resetsAt: null, lengthMs: null },
    ] }] });
    expect(pool).toMatchObject({ name: "Cursor", ttl: null, models: null });
    expect(pool.windows).toEqual([
      { kind: "monthly", label: "month · Auto", leftPct: 70, resetsAt: NOW + 10 * DAY, lengthMs: 31 * DAY },
      { kind: "weekly", label: "Weekly", leftPct: 40, resetsAt: null, lengthMs: 7 * DAY },
    ]);
  });

  test("are used only while Usage Monitor keeps publishing them", () => {
    expect(contractUsable(CONTRACT, NOW + 60_000)).toBe(true);
    expect(contractUsable(CONTRACT, NOW + CONTRACT_FRESH_MS)).toBe(false);
    expect(contractUsable({ ...CONTRACT, version: 2 }, NOW)).toBe(false);
    expect(contractUsable({ ...CONTRACT, checkedAt: undefined }, NOW)).toBe(false);
    expect(contractUsable(undefined, NOW)).toBe(false);
    expect(poolsFromContract(undefined)).toEqual([]);
  });
});

test("poolsFromReport: a window with no figure is left out, not read as 100% left", () => {
  const [pool] = poolsFromReport({ timestamp: NOW, others: [{ id: "cursor", windows: [
    { kind: "month", scope: null, used_percent: null, resets_at: null },
    { kind: "month", scope: "Auto", used_percent: 30, resets_at: null },
  ] }] });
  expect(pool.windows.map((w) => w.leftPct)).toEqual([70]);
});

describe("checkIn", () => {
  test("adds or refreshes this mod, and takes it out, leaving other consumers", () => {
    expect(checkIn(undefined, "usage-queue", true, NOW)).toEqual({ "usage-queue": NOW });
    expect(checkIn({ other: 1, "usage-queue": 2 }, "usage-queue", true, NOW)).toEqual({ other: 1, "usage-queue": NOW });
    expect(checkIn({ other: 1, "usage-queue": 2 }, "usage-queue", false, NOW)).toEqual({ other: 1 });
  });
});
