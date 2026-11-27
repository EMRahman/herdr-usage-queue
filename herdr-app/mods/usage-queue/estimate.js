// The estimate: a big model reads a job and recommends a model, effort and size per agent.

import { agentOf, modelOf } from "./catalog.js";

export const SIZES = ["s", "m", "l"];
const SIZE_TEXT = { s: "under 15 minutes of agent work", m: "15 to 60 minutes", l: "over an hour" };

/**
 * The estimator's prompt.
 * lights: one line per agent about its allowance now, e.g. "claude: green (≈32 points …)".
 * repo: what the queue read from the repository itself (its file list, the top of its README), so
 * the estimator needs no tools: headless CLIs can't ask for permission, and some (Antigravity)
 * answer with nothing at all when a command they tried is denied.
 */
export function estimatePrompt(job, catalog, lights, repo = "") {
  const agents = job.agents.map((id) => agentOf(catalog, id)).filter(Boolean);
  const routes = agents.map((a) =>
    `- ${a.id} (${a.name}): models ${a.models.map((m) => `${m.id} [${m.tier}]`).join(", ")}; efforts ${a.efforts.join(", ")}`);
  return [
    "You are choosing how to run a queued coding job on subscription coding agents.",
    "Do not run shell commands and do not change any files: everything you need is below.",
    "Answer straight away from this message.",
    "",
    `Job: ${job.title}`,
    `Repository: ${job.repo}`,
    "Prompt the agent will get:",
    '"""',
    job.prompt,
    '"""',
    "",
    ...(repo ? ["About the repository:", repo, ""] : []),
    "For each agent below, recommend the model and thinking effort that would do this job well,",
    "preferring the smallest model and effort that does it well, and a size:",
    ...SIZES.map((s) => `  ${s} = ${SIZE_TEXT[s]}`),
    "",
    "Agents (models from most to least capable):",
    ...routes,
    "",
    "Allowance right now:",
    ...lights.map((l) => `- ${l}`),
    "",
    "Answer with only this JSON object, no prose before or after it:",
    '{"recommended":"<agent id>","routes":[{"agent":"<agent id>","model":"<model id>","effort":"<effort>","size":"s|m|l","why":"<one sentence>"}]}',
  ].join("\n");
}

/** Every top-level-looking JSON object in some text, last first. */
function objectsIn(text) {
  const found = [];
  for (let start = text.lastIndexOf("{"); start !== -1; start = text.lastIndexOf("{", start - 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { found.push(JSON.parse(text.slice(start, i + 1))); } catch {}
        break;
      }
    }
    if (start === 0) break;
  }
  return found;
}

/** The text an estimator printed: Claude's and Antigravity's JSON envelopes, or plain text. */
export function answerText(stdout) {
  const trimmed = String(stdout ?? "").trim();
  try {
    const envelope = JSON.parse(trimmed);
    if (typeof envelope?.result === "string") return envelope.result;
    if (typeof envelope?.response === "string") return envelope.response;
    if (typeof envelope?.text === "string") return envelope.text;
  } catch {}
  return trimmed;
}

/**
 * The estimate from an estimator's output, checked against the catalog: unknown agents,
 * models and efforts are dropped. Throws when nothing usable is left.
 */
export function parseEstimate(stdout, catalog, jobAgents) {
  const text = answerText(stdout);
  const answer = objectsIn(text).find((o) => Array.isArray(o?.routes));
  if (!answer) throw new Error("The estimate had no recommendation in it.");
  const routes = [];
  for (const r of answer.routes) {
    const agent = agentOf(catalog, r?.agent);
    if (!agent || !jobAgents.includes(agent.id) || routes.some((x) => x.agent === agent.id)) continue;
    const model = modelOf(agent, r.model) ? r.model : null;
    const effort = agent.efforts.includes(r.effort) ? r.effort : null;
    if (!model || !effort) continue;
    routes.push({
      agent: agent.id, model, effort,
      size: SIZES.includes(r.size) ? r.size : "m",
      why: String(r.why ?? "").trim().slice(0, 300),
    });
  }
  if (!routes.length) throw new Error("The estimate didn't recommend a model this job's agents have.");
  const recommended = routes.some((r) => r.agent === answer.recommended) ? answer.recommended : routes[0].agent;
  return { recommended, routes };
}
