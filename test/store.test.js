import { describe, expect, mock, test } from "bun:test";

// store.js reads and writes through the host; back it with a map so rewriteJob can be checked.
const files = new Map();
mock.module("herdr", () => ({
  appHome: () => "/app",
  home: () => "/home",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  setShared: () => {},
  shared: () => undefined,
  readTextFile: async (path) => files.get(path) ?? null,
  writeTextFile: async (path, text, expected) => {
    if ((files.get(path) ?? null) !== expected) throw new Error("changed");
    files.set(path, text);
  },
}));
const { hashText, rewriteJob } = await import("../herdr-app/mods/usage-queue/store.js");

const original = JSON.stringify({ about: "T", prompt: "old", where: { worktree: { repo: "~/r" } }, priority: 2 }, null, 2) + "\n";

describe("rewriteJob", () => {
  test("changes the prompt and keeps the other fields", async () => {
    files.set("/j.json", original);
    const hash = await rewriteJob({ file: "/j.json", hash: hashText(original) }, (raw) => { raw.prompt = "new"; });
    const raw = JSON.parse(files.get("/j.json"));
    expect(raw).toEqual({ about: "T", prompt: "new", where: { worktree: { repo: "~/r" } }, priority: 2 });
    expect(hash).toBe(hashText(files.get("/j.json")));
  });

  test("refuses when the file changed since the job was read", async () => {
    files.set("/j.json", original);
    await expect(rewriteJob({ file: "/j.json", hash: "stale" }, (raw) => { raw.prompt = "new"; })).rejects.toThrow(/changed/);
    expect(files.get("/j.json")).toBe(original);
  });

  test("refuses when the file is gone", async () => {
    files.delete("/j.json");
    await expect(rewriteJob({ file: "/j.json", hash: "x" }, () => {})).rejects.toThrow(/gone/);
  });
});
