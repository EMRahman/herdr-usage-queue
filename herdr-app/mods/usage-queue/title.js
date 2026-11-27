// The job title: suggested from the prompt by the cheapest model there is, unless typed by hand.

import { estimateArgv, poolFor, TIERS } from "./catalog.js";
import { answerText } from "./estimate.js";

const MAX_TITLE = 60;
const MAX_PROMPT = 4000;

export function titlePrompt(prompt) {
  return [
    "Write a short title for this coding task, as for a to-do list: 3 to 7 words, sentence case,",
    "starting with a verb, no quotes and no full stop. Do not run commands or read files.",
    "Answer with only the title.",
    "",
    "Task:",
    '"""',
    String(prompt).slice(0, MAX_PROMPT),
    '"""',
  ].join("\n");
}

/** The title in a model's reply: its first non-empty line, without quotes, labels or a full stop. */
export function cleanTitle(stdout) {
  let line = answerText(stdout).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  line = line.replace(/^(title)\s*:\s*/i, "").replace(/^[#*\-\s]+/, "").replace(/[*_`]/g, "");
  line = line.replace(/^["'“‘]+|["'”’]+$/g, "").replace(/[.\s]+$/, "").trim();
  if (line.length > MAX_TITLE) line = line.slice(0, MAX_TITLE).replace(/\s+\S*$/, "");
  return line;
}

/**
 * The models that could suggest a title, cheapest first: installed agents with a one-shot command,
 * their smallest model, at their lowest effort. Within a tier, an agent with allowance (not red)
 * comes first, then one the job may use.
 */
export function titleChoices(catalog, { installed = null, pools = [], judged = {}, jobAgents = [] } = {}) {
  const choices = [];
  for (const agent of catalog.agents) {
    if (!agent.estimate || (installed && !installed.has(agent.id))) continue;
    const model = [...agent.models].sort((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier))[0];
    if (!model) continue;
    const pool = poolFor(agent, model.id, pools);
    const light = pool ? judged[pool.id]?.light : null;
    choices.push({ agent, model, effort: agent.efforts[0], light });
  }
  const rank = (c) => TIERS.indexOf(c.model.tier) * 10 + (c.light === "red" ? 4 : 0)
    + (c.light === "green" ? 0 : 1) + (jobAgents.includes(c.agent.id) ? 0 : 2);
  return choices.sort((a, b) => rank(a) - rank(b));
}

/**
 * Asks each choice in turn until one answers. exec is herdr's. Resolves with { title, by } or
 * rejects with the last error.
 */
export async function suggestTitle({ prompt, choices, exec, cwd }) {
  let last = new Error("No agent with a one-shot command is installed.");
  for (const c of choices) {
    const argv = estimateArgv(c.agent, c.model.id, c.effort, titlePrompt(prompt));
    try {
      const r = await exec(argv[0], argv.slice(1), { ...(cwd ? { cwd } : {}), timeout: 90_000 });
      const title = r.code === 0 ? cleanTitle(r.stdout) : "";
      if (title) return { title, by: `${c.agent.name} ${c.model.label}` };
      last = new Error(`${c.agent.name} ${r.code === 0 ? "gave no title" : `exited with ${r.code}`}.`);
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last;
}
