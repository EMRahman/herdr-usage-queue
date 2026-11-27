// Renders preview.html to herdr-app/preview.png (1120×700) with headless Chrome: drawn at 2x,
// then scaled down, for smooth edges. macOS, with Google Chrome installed.
//
//   bun herdr-app/preview/render.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const page = join(import.meta.dir, "preview.html");
const out = join(import.meta.dir, "..", "preview.png");
const work = mkdtempSync(join(tmpdir(), "uq-preview-"));
const shot = join(work, "shot.png");
try {
  const run = Bun.spawnSync([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    "--window-size=1120,700", "--virtual-time-budget=4000", `--user-data-dir=${work}`, `--screenshot=${shot}`, `file://${page}`],
    { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  const scale = Bun.spawnSync(["sips", "-z", "700", "1120", shot, "--out", out], { stdout: "pipe", stderr: "pipe" });
  if (scale.exitCode !== 0) throw new Error(scale.stderr.toString());
  console.log(`Wrote ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
