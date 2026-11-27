// The allowance rule: which pools the queue may spend (headroom above a reserve) and should
// spend (allowance projected to reset unused), as one traffic light per pool.
//
// Pure: readings and the time in, judgements out. No Herdr imports, so `bun test` runs it.

import { duration } from "./time.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Points of waste that make a pool worth running (Usage Monitor's Untapped threshold). */
export const MARGIN = 20;
/** Within this long of the binding reset, any waste that covers a job is worth running. */
export const RUN_BEFORE_MS = HOUR;
/** What a job is assumed to cost, in points, before there is any history. */
export const MIN_JOB_COST = 5;
/** Allowance the queue never spends, per window kind: your interactive work keeps priority. */
export const RESERVE = { "5h": 25, weekly: 15, daily: 15, monthly: 10, other: 15 };

const KIND_LENGTH = { "5h": 5 * HOUR, weekly: 7 * DAY, daily: DAY, monthly: 30 * DAY };

/** A window's kind from its label or a provider's kind word ("5h session", "Weekly",
 *  "Five Hour Limit Remaining", "week", "month"). */
export function windowKind(text) {
  const s = String(text ?? "").toLowerCase();
  if (/\b5\s*h\b|five[\s-]hour/.test(s)) return "5h";
  if (/\b7\s*d\b|week/.test(s)) return "weekly";
  if (/\b24\s*h\b|\bday\b|daily/.test(s)) return "daily";
  if (/month/.test(s)) return "monthly";
  return "other";
}

function window(label, leftPct, resetsAt, kindText = label) {
  const kind = windowKind(kindText);
  const reset = Date.parse(resetsAt ?? "");
  return {
    kind,
    label: String(label ?? kind),
    leftPct: Math.max(0, Math.min(100, Number(leftPct))),
    resetsAt: Number.isFinite(reset) ? reset : null,
    lengthMs: KIND_LENGTH[kind] ?? null,
  };
}

/** A percentage figure: null or "" is no figure, not 0. */
const isPct = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Pools from Usage Monitor's bridge report (`bridge.js --cached` → `.report`).
 * A pool is one set of windows a run draws on: a provider account, or an Antigravity model group.
 */
export function poolsFromReport(report) {
  if (!report || typeof report !== "object") return [];
  const pools = [];
  const readAt = (key) => report.read_at?.[key] ?? report.timestamp ?? null;
  const ttl = (key) => report.ttl?.[key] ?? report.ttl?.others ?? null;
  const usedWindows = (list) => (list ?? [])
    .filter((w) => isPct(w?.used_percent))
    .map((w) => window(w.label, 100 - Number(w.used_percent), w.resets_at));

  for (const [key, name] of [["claude", "Claude"], ["codex", "Codex"]]) {
    const p = report[key];
    if (!p?.windows) continue;
    pools.push({
      id: key, provider: key, name, account: p.account ?? null, plan: p.plan ?? null, models: null,
      readAt: readAt(key), ttl: ttl(key), windows: usedWindows(p.windows),
    });
  }

  for (const group of report.antigravity?.groups ?? []) {
    pools.push({
      id: `antigravity/${slug(group.name)}`, provider: "antigravity", name: `Antigravity · ${group.name}`,
      account: report.antigravity.account ?? null, plan: null,
      models: String(group.models ?? "").split(",").map((m) => m.trim()).filter(Boolean),
      readAt: readAt("antigravity"), ttl: ttl("antigravity"),
      windows: (group.buckets ?? [])
        .filter((b) => isPct(b?.remaining_percent))
        .map((b) => window(b.label, Number(b.remaining_percent), b.resets_at)),
    });
  }

  for (const p of report.others ?? []) {
    if (!p?.id || !p.windows) continue;
    pools.push({
      id: p.id, provider: p.id, name: p.name ?? p.id, account: p.account ?? null, plan: p.plan ?? null,
      models: null, readAt: readAt(p.id), ttl: ttl(p.id),
      windows: p.windows
        .filter((w) => isPct(w?.used_percent))
        .map((w) => window([w.kind, w.scope].filter(Boolean).join(" · "), 100 - Number(w.used_percent), w.resets_at, w.kind)),
    });
  }
  return pools;
}

// --- Usage Monitor's published readings (DESIGN.md: Data contract with Usage Monitor) ---

/** Shared-state keys Usage Monitor publishes and reads. */
export const WINDOWS_KEY = "usage-monitor.windows";
export const CONSUMERS_KEY = "usage-monitor.consumers";
/** Usage Monitor reads every minute while anyone is registered; older than this, nobody is
 *  publishing (an old Usage Monitor, or no readout open), so the queue asks the bridge itself. */
export const CONTRACT_FRESH_MS = 5 * 60_000;

const KINDS = new Set(["5h", "weekly", "daily", "monthly", "other"]);
const PROVIDER_NAMES = { claude: "Claude", codex: "Codex", cursor: "Cursor", copilot: "GitHub Copilot", grok: "Grok", opencode: "OpenCode" };

/** Whether Usage Monitor's published readings are there and current enough to use. */
export function contractUsable(contract, now = Date.now()) {
  return contract?.version === 1 && Array.isArray(contract.pools)
    && Number.isFinite(contract.checkedAt) && now - contract.checkedAt < CONTRACT_FRESH_MS;
}

/** Pools from Usage Monitor's published readings (`shared("usage-monitor.windows")`). */
export function poolsFromContract(contract) {
  if (!Array.isArray(contract?.pools)) return [];
  return contract.pools.filter((p) => p?.id && Array.isArray(p.windows)).map((p) => {
    const provider = String(p.provider ?? p.id);
    const name = provider === "antigravity" ? `Antigravity · ${p.name ?? p.id.split("/").slice(1).join("/")}`
      : PROVIDER_NAMES[provider] ?? p.name ?? p.id;
    return {
      id: p.id, provider, name, account: p.account ?? null, plan: p.plan ?? null,
      models: Array.isArray(p.models) ? p.models : null,
      readAt: Number.isFinite(p.readAt) ? p.readAt : null, ttl: Number.isFinite(p.ttlMs) ? p.ttlMs : null,
      windows: p.windows.filter((w) => Number.isFinite(w?.leftPct)).map((w) => {
        const base = window(w.label, w.leftPct, w.resetsAt, KINDS.has(w.kind) ? w.kind : w.label);
        return Number.isFinite(w.lengthMs) ? { ...base, lengthMs: w.lengthMs } : base;
      }),
    };
  });
}

/** "usage-monitor.consumers" with this mod checked in now (`wanted`) or taken out. */
export function checkIn(consumers, id, wanted, now = Date.now()) {
  const next = { ...(consumers && typeof consumers === "object" ? consumers : {}) };
  if (wanted) next[id] = now;
  else delete next[id];
  return next;
}

/**
 * One pool's verdict.
 * light: "green" (allowance would reset unused: worth running), "yellow" (above the reserve,
 * nothing going to waste), "red" (at or below the reserve, stale or unknown).
 * headroom: points above the reserve on the tightest window. waste: points projected to reset
 * unused (the smallest spare across timed windows). urgency: waste per hour until the binding
 * reset. reason: one line for people. changesAt: when a red light can next change (ms), or null.
 */
export function judgePool(pool, now = Date.now(), reserve = RESERVE) {
  const base = { id: pool.id, headroom: 0, waste: 0, urgency: 0, binding: null, changesAt: null };
  if (!pool.windows?.length) return { ...base, light: "red", reason: "No allowance reading" };
  if (pool.readAt && pool.ttl && now - pool.readAt > 2 * pool.ttl + 5 * 60_000) {
    return { ...base, light: "red", reason: `Reading is stale (${duration(now - pool.readAt)} old)` };
  }

  // May the queue spend here? The tightest window above its reserve.
  let tight = null;
  for (const w of pool.windows) {
    const room = w.leftPct - (reserve[w.kind] ?? reserve.other);
    if (!tight || room < tight.room) tight = { w, room };
  }
  const headroom = tight.room;
  if (headroom < MIN_JOB_COST) {
    const r = reserve[tight.w.kind] ?? reserve.other;
    const until = tight.w.resetsAt && tight.w.resetsAt > now ? ` · resets in ${duration(tight.w.resetsAt - now)}` : "";
    return {
      ...base, headroom, light: "red", changesAt: tight.w.resetsAt,
      reason: `${tight.w.label}: ${Math.round(tight.w.leftPct)}% left, reserve ${r}%${until}`,
    };
  }

  // Should it? A window's leftover is lost only if every window would end with some left, so
  // the waste is the smallest spare across the windows that are running on a clock.
  let binding = null;
  for (const w of pool.windows) {
    if (!w.resetsAt || !w.lengthMs || w.resetsAt <= now) continue;
    const timeLeftPct = Math.min(100, ((w.resetsAt - now) / w.lengthMs) * 100);
    const spare = w.leftPct - timeLeftPct;
    if (!binding || spare < binding.spare) binding = { w, spare };
  }
  const waste = binding ? Math.max(0, binding.spare) : 0;
  const msToReset = binding ? binding.w.resetsAt - now : Infinity;
  const urgency = binding ? waste / Math.max(msToReset / HOUR, 0.1) : 0;
  const green = waste >= MARGIN || (msToReset <= RUN_BEFORE_MS && waste >= MIN_JOB_COST);
  const judged = { ...base, headroom, waste, urgency, binding: binding?.w ?? null };
  if (green) {
    return {
      ...judged, light: "green",
      reason: `≈${Math.round(waste)} points of ${binding.w.label} reset unused in ${duration(msToReset)}`,
    };
  }
  return { ...judged, light: "yellow", reason: `${Math.round(headroom)} points above reserve; nothing going to waste` };
}

const RANK = { green: 2, yellow: 1, red: 0 };

/** The better of two judgements: greener first, then more urgent, then more headroom. */
export function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  const d = RANK[a.light] - RANK[b.light] || a.urgency - b.urgency || a.headroom - b.headroom;
  return d >= 0 ? a : b;
}

/** Judgements for every pool, by id. */
export function judgeAll(pools, now = Date.now(), reserve = RESERVE) {
  return Object.fromEntries(pools.map((p) => [p.id, judgePool(p, now, reserve)]));
}
