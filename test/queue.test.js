import { describe, expect, test } from "bun:test";
import { DEFAULT_CATALOG, estimateArgv, launchArgv, mergeCatalog, poolFor } from "../herdr-app/mods/usage-queue/catalog.js";
import { estimatePrompt, parseEstimate } from "../herdr-app/mods/usage-queue/estimate.js";
import {
  agentLights, classify, dueToLaunch, estimatorChoices, jobText, pinnedRoute, proposeRoute, readJob,
} from "../herdr-app/mods/usage-queue/queue.js";

const catalog = mergeCatalog(null);
const agent = (id) => catalog.agents.find((a) => a.id === id);

const pools = [
  { id: "claude", windows: [] },
  { id: "codex", windows: [] },
  { id: "antigravity/gemini-models", models: ["Gemini 4 Neon", "Gemini 3.8 Flash"], windows: [] },
  { id: "antigravity/claude-and-gpt-models", models: ["Claude Opus 5.5", "Claude Sonnet 5.5"], windows: [] },
];
const j = (light, extra = {}) => ({ light, waste: 0, headroom: 30, urgency: 0, reason: light, ...extra });

describe("catalog", () => {
  test("Antigravity models find their group's pool", () => {
    expect(poolFor(agent("agy"), "gemini-4-neon", pools).id).toBe("antigravity/gemini-models");
    expect(poolFor(agent("agy"), "claude-opus-5-5", pools).id).toBe("antigravity/claude-and-gpt-models");
    expect(poolFor(agent("claude"), "opus", pools).id).toBe("claude");
  });

  test("launch and estimate commands", () => {
    expect(launchArgv(agent("claude"), "sonnet", "medium")).toEqual(["claude", "--model", "sonnet", "--effort", "medium"]);
    expect(launchArgv(agent("codex"), "gpt-6.2-sol", "high"))
      .toEqual(["codex", "--no-daemon", "--model", "gpt-6.2-sol", "-c", 'model_reasoning_effort="high"']);
    expect(launchArgv(agent("agy"), "gemini-4-neon", "high")).toEqual(["agy", "--model", "gemini-4-neon-high"]);
    expect(estimateArgv(agent("claude"), "opus", "high", "P").at(-1)).toBe("P");
    expect(estimateArgv(agent("agy"), "gemini-4-neon", "high", 'say {"x":1}').at(-1)).toBe('--print=say {"x":1}');
  });

  test("an override replaces an agent's fields and can add agents", () => {
    const c = mergeCatalog({ agents: [{ id: "claude", run: ["my-claude"] }, { id: "pi", name: "Pi", run: ["pi"], models: [], efforts: [] }] });
    expect(c.agents.find((a) => a.id === "claude").run).toEqual(["my-claude"]);
    expect(c.agents.find((a) => a.id === "claude").models.length).toBe(3);
    expect(c.agents.at(-1).id).toBe("pi");
  });
});

describe("jobs", () => {
  test("a job file round-trips", () => {
    const text = jobText({ title: "Flaky tests", prompt: "Fix them", repo: "~/Code/app", agents: ["claude", "codex"], priority: 2 });
    const { job } = readJob("flaky", text);
    expect(job).toMatchObject({ id: "flaky", title: "Flaky tests", repo: "~/Code/app", agents: ["claude", "codex"], priority: 2, after: null });
    expect(text).not.toContain("after");
  });

  test("a job file keeps the job it waits for", () => {
    const text = jobText({ title: "Asia", prompt: "Map", repo: "~/Code/app", agents: ["codex"], priority: 2, after: "tunnels-1" });
    expect(readJob("asia", text).job.after).toBe("tunnels-1");
  });

  test("a job without a prompt or repo is an error", () => {
    expect(readJob("x", "{}").error).toContain("prompt");
    expect(readJob("x", '{"prompt":"p"}').error).toContain("repository");
    expect(readJob("x", "nope").error).toContain("JSON");
  });

  test("a pinned model and effort make a route", () => {
    const { job } = readJob("x", JSON.stringify({ prompt: "p", repo: "/r", agents: ["claude"], model: { claude: "sonnet" }, effort: { claude: "low" } }));
    expect(pinnedRoute(catalog, job)).toMatchObject({ agent: "claude", model: "sonnet", effort: "low" });
  });

  test("classify: approval holds only for the file it was given for", () => {
    const jobs = [
      { id: "a", hash: "h1", priority: 2, createdAt: 1 },
      { id: "b", hash: "h2", priority: 1, createdAt: 2 },
      { id: "c", hash: "h3", priority: 1, createdAt: 3 },
      { id: "d", hash: "h4", priority: 1, createdAt: 4 },
    ];
    const state = { jobs: {
      a: { approval: { hash: "h1" } },
      b: { approval: { hash: "old" } },
      d: { approval: { hash: "h4" }, launched: { hash: "h4", at: 5 } },
    } };
    const lists = classify(jobs, state);
    expect(lists.ready.map((x) => x.id)).toEqual(["a"]);
    expect(lists.pending.map((x) => x.id)).toEqual(["b", "c"]);
    expect(lists.launched.map((x) => x.id)).toEqual(["d"]);
  });
});

describe("choices", () => {
  const judged = {
    claude: j("yellow", { headroom: 40 }),
    codex: j("green", { waste: 30, urgency: 5 }),
    "antigravity/gemini-models": j("red"),
    "antigravity/claude-and-gpt-models": j("yellow", { headroom: 10 }),
  };

  test("agent lights take the best pool", () => {
    const lights = agentLights(catalog, pools, judged);
    expect(lights.map((l) => [l.agent.id, l.judgement.light])).toEqual([["claude", "yellow"], ["codex", "green"], ["agy", "yellow"]]);
  });

  test("the suggested estimator is the green big model; red ones can't be picked", () => {
    const { choices, suggested } = estimatorChoices(catalog, pools, judged);
    expect(suggested.agent.id).toBe("codex");
    expect(choices.find((c) => c.model.id === "gemini-4-neon").usable).toBe(false);
  });

  test("the proposal goes to the greenest route", () => {
    const estimate = { recommended: "claude", routes: [
      { agent: "claude", model: "sonnet", effort: "medium", size: "m", why: "" },
      { agent: "codex", model: "gpt-6.2-sol", effort: "high", size: "m", why: "" },
    ] };
    expect(proposeRoute(catalog, estimate, pools, judged).agent).toBe("codex");
    const allYellow = { ...judged, codex: j("yellow", { headroom: 60 }) };
    expect(proposeRoute(catalog, estimate, pools, allYellow).agent).toBe("claude");
  });
});

describe("dueToLaunch", () => {
  const route = (agent, model) => ({ agent, model, effort: "medium" });
  const jobs = [
    { id: "a", hash: "a", priority: 1, createdAt: 1 },
    { id: "b", hash: "b", priority: 2, createdAt: 2 },
    { id: "c", hash: "c", priority: 3, createdAt: 3 },
    { id: "m", hash: "m", priority: 1, createdAt: 4 },
  ];
  const state = (extra = {}) => ({ jobs: {
    a: { approval: { hash: "a", auto: true, route: route("claude", "sonnet") } },
    b: { approval: { hash: "b", auto: true, route: route("claude", "opus") } },
    c: { approval: { hash: "c", auto: true, route: route("codex", "gpt-6.2-sol") } },
    m: { approval: { hash: "m", auto: false, route: route("codex", "gpt-6.2-sol") } },
  }, ...extra });
  const judged = (claude, codex) => ({ claude: j(claude), codex: j(codex) });

  test("one per pool, by priority; manual jobs never", () => {
    expect(dueToLaunch(jobs, state(), catalog, pools, judged("yellow", "green")).map((x) => x.id)).toEqual(["a", "c"]);
  });

  test("nothing on red, and nothing while paused", () => {
    expect(dueToLaunch(jobs, state(), catalog, pools, judged("red", "red"))).toEqual([]);
    expect(dueToLaunch(jobs, state({ paused: true }), catalog, pools, judged("green", "green"))).toEqual([]);
  });

  test("a pool something launched on recently is left to settle", () => {
    const s = state();
    s.jobs.x = { launched: { pool: "claude", at: 1_000 } };
    expect(dueToLaunch(jobs, s, catalog, pools, judged("green", "red"), 1_000 + 5 * 60_000).map((x) => x.id)).toEqual([]);
    expect(dueToLaunch(jobs, s, catalog, pools, judged("green", "red"), 1_000 + 11 * 60_000).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("estimate", () => {
  const job = { title: "T", repo: "/r", prompt: "Do it", agents: ["claude", "codex"] };

  test("the prompt lists only the job's agents", () => {
    const p = estimatePrompt(job, catalog, ["claude: green"]);
    expect(p).toContain("- claude (Claude)");
    expect(p).toContain("- codex (Codex)");
    expect(p).not.toContain("- agy");
  });

  test("parses Claude's JSON envelope and drops what the catalog doesn't know", () => {
    const answer = { recommended: "codex", routes: [
      { agent: "claude", model: "sonnet", effort: "medium", size: "s", why: "Small change." },
      { agent: "codex", model: "gpt-9", effort: "high", size: "m", why: "" },
      { agent: "agy", model: "gemini-4-neon", effort: "high", size: "m", why: "" },
    ] };
    const stdout = JSON.stringify({ type: "result", result: "Here you go:\n```json\n" + JSON.stringify(answer) + "\n```" });
    const e = parseEstimate(stdout, catalog, job.agents);
    expect(e.routes).toEqual([{ agent: "claude", model: "sonnet", effort: "medium", size: "s", why: "Small change." }]);
    expect(e.recommended).toBe("claude");
  });

  test("plain text output works too, and nothing usable throws", () => {
    const stdout = 'thinking...\n{"recommended":"claude","routes":[{"agent":"claude","model":"opus","effort":"high","size":"l","why":"Big."}]}';
    expect(parseEstimate(stdout, catalog, job.agents).routes[0].model).toBe("opus");
    expect(() => parseEstimate("no json here", catalog, job.agents)).toThrow();
  });
});

test("the default catalog has a big model per agent", () => {
  for (const a of DEFAULT_CATALOG.agents) expect(a.models.some((m) => m.tier === "big")).toBe(true);
});

describe("waiting for another job", () => {
  const { blockedBy, canWaitFor, isFinished } = require("../herdr-app/mods/usage-queue/queue.js");
  const route = { agent: "claude", model: "sonnet", effort: "medium" };
  const jobs = [
    { id: "a", hash: "a", priority: 1, createdAt: 1 },
    { id: "b", hash: "b", priority: 1, createdAt: 2 },
    { id: "c", hash: "c", priority: 1, createdAt: 3, after: "b" },
  ];
  const launched = (pr) => ({ approval: { hash: "x", route }, launched: { at: 1, pr } });

  test("a PR job is finished when its PR is merged; others when their agent stopped", () => {
    expect(isFinished(launched({ mode: "merge", phase: "in-review" }))).toBe(false);
    expect(isFinished(launched({ mode: "merge", phase: "merged" }))).toBe(true);
    expect(isFinished({ launched: { at: 1 } })).toBe(false);
    expect(isFinished({ launched: { at: 1, finishedAt: 2 } })).toBe(true);
    expect(isFinished({ launched: { at: 1, markedFinishedAt: 2 } })).toBe(true);
    expect(isFinished(launched({ mode: "merge", phase: "needs-you" }))).toBe(false);
    expect(isFinished({ launched: { at: 1, markedFinishedAt: 2, pr: { mode: "merge", phase: "needs-you" } } })).toBe(true);
  });

  test("blocked until the job it waits for is finished", () => {
    const state = { jobs: {
      a: launched({ mode: "merge", phase: "in-review" }),
      b: { approval: { hash: "b", route, after: "a" } },
    } };
    expect(blockedBy(jobs[1], jobs, state)).toMatchObject({ job: { id: "a" }, why: "hasn't had its PR merged yet" });
    state.jobs.a.launched.pr.phase = "merged";
    expect(blockedBy(jobs[1], jobs, state)).toBe(null);
  });

  test("the job file's \"after\" counts too, and a deleted job doesn't hold anything up", () => {
    expect(blockedBy(jobs[2], jobs, { jobs: {} }).why).toBe("isn't launched yet");
    expect(blockedBy({ id: "z", after: "gone" }, jobs, { jobs: {} })).toBe(null);
  });

  test("no loops: a job can't wait for one that waits for it", () => {
    const state = { jobs: { b: { approval: { hash: "b", route, after: "a" } } } };
    // a can't wait for b (b waits for a) or c (c waits for b, which waits for a); c can wait for either.
    expect(canWaitFor(jobs[0], jobs, state).map((j) => j.id)).toEqual([]);
    expect(canWaitFor(jobs[2], jobs, state).map((j) => j.id)).toEqual(["a", "b"]);
  });

  test("Auto doesn't launch a job that's waiting", () => {
    const state = { jobs: {
      a: launched({ mode: "merge", phase: "in-review" }),
      b: { approval: { hash: "b", auto: true, route, after: "a" } },
    } };
    const judged = { claude: { light: "green", waste: 30, headroom: 40, urgency: 5 } };
    expect(dueToLaunch(jobs.slice(0, 2), state, catalog, pools, judged)).toEqual([]);
    state.jobs.a.launched.pr.phase = "merged";
    expect(dueToLaunch(jobs.slice(0, 2), state, catalog, pools, judged).map((j) => j.id)).toEqual(["b"]);
  });
});

describe("choosing by hand", () => {
  const { defaultRoute, routeOptions } = require("../herdr-app/mods/usage-queue/queue.js");
  test("each agent starts at its mid-tier model and medium effort", () => {
    expect(defaultRoute(catalog, "claude")).toMatchObject({ agent: "claude", model: "sonnet", effort: "medium" });
    expect(defaultRoute(catalog, "codex")).toMatchObject({ model: "gpt-6.2-sol", effort: "medium" });
    expect(defaultRoute(catalog, "nope")).toBe(null);
  });

  test("every agent of the job can be picked, with or without an estimate", () => {
    const job = { agents: ["claude", "codex"] };
    expect(routeOptions(catalog, job, null).map((r) => r.agent)).toEqual(["claude", "codex"]);
    const estimate = { routes: [{ agent: "codex", model: "gpt-6-luna", effort: "low", size: "s", why: "Small." }] };
    expect(routeOptions(catalog, job, estimate).map((r) => `${r.agent}:${r.model}`)).toEqual(["codex:gpt-6-luna", "claude:sonnet"]);
  });
});

test("by hand, the default is the agent with the most room when none is going to waste", () => {
  const { routeOptions } = require("../herdr-app/mods/usage-queue/queue.js");
  const judged = { claude: j("yellow", { headroom: 7 }), codex: j("yellow", { headroom: 36 }) };
  const routes = routeOptions(catalog, { agents: ["claude", "codex"] }, null);
  expect(proposeRoute(catalog, { routes, recommended: null }, pools, judged).agent).toBe("codex");
});
