// Installs Usage Queue into the Herdr app: copies the mod and adds its block to the sidebar of a
// personal layout (the one on screen, or --layout <name>).
//
//   bun herdr-app/install.ts [--layout <name>] [--no-skill]
//
// Also installs the usage-queue skill for Claude Code (and Codex, when ~/.codex exists), so an
// agent can queue jobs with the mod's cli.js. --no-skill leaves it out.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MOD = "usage-queue";
const home = resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"));
const source = join(import.meta.dir, "mods", MOD);
const destination = join(home, "mods", MOD);
const SHIPPED = new Set(["main", "terminals", "win98"]);
const SKILL = join(import.meta.dir, "skills", MOD, "SKILL.md");

interface LayoutNode {
  id?: string;
  type?: string;
  size?: { px?: number; weight?: number };
  content?: { mod?: string; props?: Record<string, unknown> };
  children?: LayoutNode[];
  [key: string]: unknown;
}

// Dragging a line between two blocks resizes the fixed-height one (the upper one if both are),
// and everything weighted around it shares out the difference. So the queue goes right after
// the whole lists column (spaces, agents, Context Monitor's block), not inside it: its top line
// then sits between two weighted nodes and moves exactly as dragged. Weight 0.35 starts it at
// about a quarter of the lists' height.
const BLOCK: LayoutNode = { id: MOD, type: "block", size: { weight: 0.35 }, min: 90, content: { mod: MOD } };

// Herdr reloads a mod whenever a file in its folder is saved: write only what changed.
function writeIfChanged(path: string, data: string | Buffer): boolean {
  const next = Buffer.from(data);
  if (existsSync(path) && readFileSync(path).equals(next)) return false;
  writeFileSync(path, next);
  return true;
}

function find(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function parentOf(node: LayoutNode, id: string): LayoutNode | null {
  for (const child of node.children ?? []) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}

/** Puts the block right below the sidebar's lists column (so below Context Monitor's block when
 *  there is one), else below the agents list, else above Usage Monitor's readout or the footer.
 *  Only inserts; never wraps other nodes. */
function insert(tree: LayoutNode): boolean {
  for (const [anchor, after] of [["sidebar-lists", true], ["agents", true], ["usage-monitor", false], ["sidebar-footer", false]] as const) {
    const parent = parentOf(tree, anchor);
    if (!parent?.children) continue;
    const at = parent.children.findIndex((c) => c.id === anchor);
    parent.children.splice(after ? at + 1 : at, 0, structuredClone(BLOCK));
    return true;
  }
  return false;
}

function shownLayout(): string | null {
  const herdrApp = Bun.which("herdr-app");
  if (!herdrApp) return null;
  const status = Bun.spawnSync([herdrApp, "status"], { stdout: "pipe", stderr: "ignore" });
  try {
    const layout = JSON.parse(status.stdout.toString()).layout;
    return typeof layout === "string" ? layout : null;
  } catch {
    return null;
  }
}

/** Where agents look for skills: Claude Code always, Codex when it's set up. */
function skillFolders(): string[] {
  const claude = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const codex = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  return [join(claude, "skills", MOD), ...(existsSync(codex) ? [join(codex, "skills", MOD)] : [])];
}

/** Writes the skill with the command filled in: this Bun and the installed cli.js, both absolute,
 *  so it works from any agent's shell whatever its PATH. */
function installSkill() {
  const quote = (s: string) => (/^[\w./~-]+$/.test(s) ? s : `"${s}"`);
  const cli = `${quote(process.execPath)} ${quote(join(destination, "cli.js"))}`;
  const text = readFileSync(SKILL, "utf8").replaceAll("{{cli}}", cli);
  for (const folder of skillFolders()) {
    mkdirSync(folder, { recursive: true });
    const wrote = writeIfChanged(join(folder, "SKILL.md"), text);
    console.log(`${wrote ? "Installed" : "Already installed:"} the usage-queue skill in ${folder}`);
  }
}

function install() {
  if (!existsSync(join(home, "layouts"))) throw new Error("Open the Herdr app once to set up its configuration, then rerun this.");
  if (!existsSync(join(home, "mods", "usage-monitor", "bridge.js"))) {
    console.warn("Usage Monitor isn't installed: the queue reads allowance from it. Install it from github.com/EMRahman/herdr-usage-monitor.");
  }

  const flag = process.argv.indexOf("--layout");
  const name = flag === -1 ? shownLayout() : process.argv[flag + 1];
  if (!name) throw new Error("Couldn't tell which layout is on screen. Rerun with --layout <name>.");
  if (SHIPPED.has(name)) {
    throw new Error(`${name} is one of Herdr's own layouts, which it replaces on every start. Clone it first:\n  herdr-app do layout.clone '{"name":"${name}","as":"my-layout"}'\nthen rerun with --layout my-layout.`);
  }
  const layoutPath = join(home, "layouts", `${name}.json`);
  if (!existsSync(layoutPath)) throw new Error(`There's no layout named ${name} in ${join(home, "layouts")}.`);

  // The mod first, the layout block last: a new block starts its mod, which should find its files.
  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(source).filter((f) => f.endsWith(".js") || f.endsWith(".svg") || f === "mod.json")) {
    writeIfChanged(join(destination, file), readFileSync(join(source, file)));
  }

  const herdrApp = Bun.which("herdr-app");
  if (herdrApp) {
    const check = Bun.spawnSync([herdrApp, "check", destination], { stdout: "pipe", stderr: "pipe" });
    if (check.exitCode !== 0) throw new Error(`herdr-app check failed:\n${check.stderr.toString() || check.stdout.toString()}`);
  }

  if (!process.argv.includes("--no-skill")) installSkill();

  const tree = JSON.parse(readFileSync(layoutPath, "utf8")) as LayoutNode;
  // Reinstalling puts the block back in its place, as a weighted share (earlier installs used
  // other places and a fixed height).
  const existing = find(tree, MOD);
  if (existing) {
    const parent = parentOf(tree, MOD)!;
    parent.children = parent.children!.filter((c) => c.id !== MOD);
  }
  if (!insert(tree)) throw new Error(`The ${name} layout has no standard Herdr sidebar to add the queue to.`);
  const wrote = writeIfChanged(layoutPath, JSON.stringify(tree, null, 2) + "\n");
  console.log(wrote ? `Put Usage Queue in the sidebar of the ${name} layout.` : `Usage Queue is already in the ${name} layout.`);
  console.log(`Jobs live in ${join(home, MOD, "jobs")}. Click + in the queue to add one.`);
}

try {
  install();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
