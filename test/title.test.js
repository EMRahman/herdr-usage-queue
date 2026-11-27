import { describe, expect, test } from "bun:test";
import { mergeCatalog } from "../herdr-app/mods/usage-queue/catalog.js";
import { cleanTitle, suggestTitle, titleChoices, titlePrompt } from "../herdr-app/mods/usage-queue/title.js";

const catalog = mergeCatalog(null);
const pools = [
  { id: "claude", windows: [] },
  { id: "codex", windows: [] },
];

describe("title", () => {
  test("the reply is cleaned to one short line", () => {
    expect(cleanTitle(JSON.stringify({ result: '"Fix flaky login tests."\n' }))).toBe("Fix flaky login tests");
    expect(cleanTitle("Title: **Add dark mode**")).toBe("Add dark mode");
    expect(cleanTitle("\n\n")).toBe("");
    expect(cleanTitle("word ".repeat(30)).length).toBeLessThanOrEqual(60);
  });

  test("the prompt carries the task", () => {
    expect(titlePrompt("Make the build faster")).toContain("Make the build faster");
  });

  test("the cheapest installed model comes first, at its lowest effort", () => {
    const choices = titleChoices(catalog, { installed: new Set(["claude", "codex"]), pools, judged: {}, jobAgents: ["claude"] });
    expect(choices.map((c) => c.agent.id)).toEqual(["claude", "codex"]);
    expect(choices[0].model.id).toBe("haiku");
    expect(choices[0].effort).toBe("low");
  });

  test("an agent out of allowance goes last", () => {
    const judged = { claude: { light: "red" }, codex: { light: "green" } };
    const choices = titleChoices(catalog, { installed: new Set(["claude", "codex"]), pools, judged, jobAgents: ["claude"] });
    expect(choices.map((c) => c.agent.id)).toEqual(["codex", "claude"]);
  });

  test("a smaller tier beats a bigger one, whatever the allowance", () => {
    const big = mergeCatalog({ agents: [{ id: "claude", models: [{ id: "opus", label: "Opus", tier: "big" }] }] });
    const judged = { claude: { light: "green" }, codex: { light: "red" } };
    const choices = titleChoices(big, { installed: new Set(["claude", "codex"]), pools, judged, jobAgents: ["claude"] });
    expect(choices.map((c) => c.model.id)).toEqual(["gpt-6-luna", "opus"]);
  });

  test("it falls back to the next model when one fails", async () => {
    const choices = titleChoices(catalog, { installed: new Set(["claude", "codex"]), pools, jobAgents: ["claude"] });
    const calls = [];
    const exec = async (cmd) => {
      calls.push(cmd);
      return cmd === "claude" ? { code: 1, stdout: "", stderr: "no" } : { code: 0, stdout: "Speed up the build\n", stderr: "" };
    };
    expect(await suggestTitle({ prompt: "make it faster", choices, exec })).toEqual({ title: "Speed up the build", by: "Codex GPT-6 Luna" });
    expect(calls).toEqual(["claude", "codex"]);
  });

  test("with nothing installed it says so", async () => {
    await expect(suggestTitle({ prompt: "x", choices: [], exec: async () => ({}) })).rejects.toThrow("installed");
  });
});
