import { describe, expect, test } from "bun:test";
import { activeRepos, mainCheckout } from "../herdr-app/mods/usage-queue/repos.js";

// A fake git: folders under a repo's checkout or its worktrees, as `git rev-parse` would answer.
const repos = {
  "/code/app": { top: "/code/app", common: "/code/app/.git" },
  "/code/app/src": { top: "/code/app", common: "/code/app/.git" },
  "/wt/app/feature": { top: "/wt/app/feature", common: "/code/app/.git" },
  "/code/lib": { top: "/code/lib", common: "/code/lib/.git" },
  "/code/bare": { top: "/code/bare", common: "/srv/bare.git" },
};
const git = async (cwd, args) => {
  const r = Object.values(repos).find((x) => x.top === cwd) ?? repos[cwd];
  if (!r) return { ok: false, out: "" };
  return { ok: true, out: args.includes("--show-toplevel") ? r.top : r.common };
};
const resolve = (folder) => mainCheckout(git, folder);

describe("repos", () => {
  test("a worktree or subfolder counts as its repo's main checkout", async () => {
    expect(await resolve("/wt/app/feature")).toBe("/code/app");
    expect(await resolve("/code/app/src")).toBe("/code/app");
    expect(await resolve("/tmp")).toBeNull();
    // A common dir that isn't <checkout>/.git: the folder's own top level names it.
    expect(await resolve("/code/bare")).toBe("/code/bare");
  });

  test("folders collapse to one choice per repo, in order, without non-repos", async () => {
    const list = await activeRepos(["/wt/app/feature", "/tmp", "/code/lib", "/code/app/src", "", "/code/lib"], resolve);
    expect(list.map((r) => r.path)).toEqual(["/code/app", "/code/lib"]);
    expect(list[0].name).toBe("app");
    expect(list[0].folders).toEqual(["/code/app", "/wt/app/feature", "/code/app/src"]);
  });

  test("a failing lookup is left out, and the list is capped", async () => {
    const throwing = async (f) => { if (f === "/bad") throw new Error("no"); return f; };
    const list = await activeRepos(["/bad", "/a", "/b", "/c"], throwing, 2);
    expect(list.map((r) => r.path)).toEqual(["/a", "/b"]);
  });
});
