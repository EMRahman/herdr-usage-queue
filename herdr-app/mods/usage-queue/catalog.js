// The coding agents the queue can route to: how to start each, its models and efforts, and
// which pool each model draws on. `catalog.json` in the data folder overrides any agent by id.

/** Tiers, most capable first. Only "big" models run estimates. */
export const TIERS = ["big", "mid", "small"];

export const DEFAULT_CATALOG = {
  agents: [
    {
      id: "claude", name: "Claude", run: ["claude"], pool: "claude",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      models: [
        { id: "opus", label: "Opus", tier: "big" },
        { id: "sonnet", label: "Sonnet", tier: "mid" },
        { id: "haiku", label: "Haiku", tier: "small" },
      ],
      // {model} and {effort} are filled in; an empty list leaves the agent's default.
      flags: { model: ["--model", "{model}"], effort: ["--effort", "{effort}"] },
      estimate: ["claude", "-p", "--model", "{model}", "--effort", "{effort}", "--permission-mode", "plan",
        "--output-format", "json", "{prompt}"],
    },
    {
      id: "codex", name: "Codex", run: ["codex", "--no-daemon"], pool: "codex",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      models: [
        { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", tier: "big" },
        { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", tier: "mid" },
        { id: "gpt-6-luna", label: "GPT-6 Luna", tier: "small" },
      ],
      flags: { model: ["--model", "{model}"], effort: ["-c", "model_reasoning_effort=\"{effort}\""] },
      estimate: ["codex", "exec", "--model", "{model}", "-c", "model_reasoning_effort=\"{effort}\"",
        "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "{prompt}"],
    },
    {
      id: "agy", name: "Antigravity", run: ["agy"],
      // No fixed pool: each model draws on the Antigravity group that lists it.
      poolPrefix: "antigravity/",
      efforts: ["low", "medium", "high"],
      models: [
        { id: "gemini-4-neon", label: "Gemini 4 Neon", tier: "big" },
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "big" },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "mid" },
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", tier: "small" },
      ],
      flags: { model: ["--model", "{model}-{effort}"], effort: [] },
      // agy takes the prompt as the flag's own value, attached with "=".
      estimate: ["agy", "--model", "{model}-{effort}", "--mode", "plan", "--output-format", "json", "--print={prompt}"],
    },
  ],
};

/** The default catalog with overrides merged in by agent id (an override replaces whole fields). */
export function mergeCatalog(override) {
  const agents = DEFAULT_CATALOG.agents.map((a) => ({ ...a }));
  for (const o of override?.agents ?? []) {
    if (!o?.id) continue;
    const i = agents.findIndex((a) => a.id === o.id);
    if (i === -1) agents.push(o);
    else agents[i] = { ...agents[i], ...o };
  }
  return { agents };
}

export const agentOf = (catalog, id) => catalog.agents.find((a) => a.id === id) ?? null;
export const modelOf = (agent, id) => agent?.models.find((m) => m.id === id) ?? null;

/** The pool a model draws on, or null when no reading has it. */
export function poolFor(agent, modelId, pools) {
  if (!agent) return null;
  if (agent.pool) return pools.find((p) => p.id === agent.pool) ?? null;
  const model = modelOf(agent, modelId);
  const label = (model?.label ?? modelId ?? "").toLowerCase();
  return pools.find((p) => p.id.startsWith(agent.poolPrefix ?? "\0")
    && (p.models ?? []).some((m) => m.toLowerCase() === label)) ?? null;
}

/** Every pool an agent can draw on. */
export function poolsOfAgent(agent, pools) {
  if (agent.pool) return pools.filter((p) => p.id === agent.pool);
  return pools.filter((p) => p.id.startsWith(agent.poolPrefix ?? "\0"));
}

const fill = (parts, vars) => parts.map((part) => part.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""));

/** The argv that starts an agent interactively with this model and effort. */
export function launchArgv(agent, model, effort) {
  const vars = { model, effort };
  return [
    ...agent.run,
    ...(model ? fill(agent.flags?.model ?? [], vars) : []),
    ...(effort ? fill(agent.flags?.effort ?? [], vars) : []),
  ];
}

/** The argv for a one-shot, read-only estimate run. */
export function estimateArgv(agent, model, effort, prompt) {
  return fill(agent.estimate, { model, effort, prompt });
}

/** The big models that could run an estimate. */
export const estimators = (catalog) => catalog.agents.flatMap((agent) =>
  agent.estimate ? agent.models.filter((m) => m.tier === "big").map((m) => ({ agent, model: m })) : []);

/** The effort an estimator runs at: high, or the agent's highest below that. */
export function estimatorEffort(agent) {
  return agent.efforts.includes("high") ? "high" : agent.efforts.at(-1);
}
