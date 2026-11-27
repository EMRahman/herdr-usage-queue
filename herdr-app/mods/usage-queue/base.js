// Which commit a launched job starts from. No Herdr imports: `git` is passed in, so tests run it
// against real repositories.
//
// A job's "base":
//   "remote" (default): fetch, then the remote's default branch as just fetched (origin/main):
//                       the repo's latest on GitHub, whatever your checkout has.
//   "local":            your checkout's HEAD at launch: its branch, unpushed commits included.
//   "<branch>":         that branch on the remote as just fetched, else the local branch.

/** The job file's base, checked. */
export function baseOf(raw) {
  const base = typeof raw?.base === "string" ? raw.base.trim() : "";
  return base || "remote";
}

/** "origin/main" from `git symbolic-ref refs/remotes/origin/HEAD` output, or null. */
export function remoteHeadRef(symref, remote) {
  const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(symref ?? "").trim().match(new RegExp(`^refs/remotes/(${escaped}/.+)$`));
  return m ? m[1] : null;
}

/** "main" from `git ls-remote --symref <remote> HEAD` output, or null. */
export function lsRemoteHead(output) {
  const m = String(output ?? "").match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return m ? m[1] : null;
}

/**
 * Resolves the commit to start from. `git(args)` runs git in the repo and resolves with
 * { ok, out, err }. Resolves with { ref, commit, note }: ref is what was used ("origin/main",
 * "HEAD"); note says why it fell back to the local HEAD, or is "".
 */
export async function resolveBase(git, base) {
  const local = async (note) => {
    const head = await git(["rev-parse", "HEAD"]);
    if (!head.ok) throw new Error("The repository has no commits yet.");
    return { ref: "HEAD", commit: head.out, note };
  };
  if (base === "local") return local("");

  const remotes = (await git(["remote"])).out.split("\n").map((r) => r.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) return local("The repository has no remote, so it started from your local HEAD.");

  const fetched = await git(["fetch", "--quiet", remote], 120_000);
  if (!fetched.ok) {
    return local(`Couldn't fetch ${remote} (${fetched.err.split("\n").at(-1) || "no reason given"}), so it started from your local HEAD.`);
  }

  let ref = null;
  if (base === "remote") {
    ref = remoteHeadRef((await git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`])).out, remote);
    if (!ref) {
      // A clone made without it doesn't know the remote's default branch: ask the remote.
      const branch = lsRemoteHead((await git(["ls-remote", "--symref", remote, "HEAD"], 60_000)).out);
      if (branch) ref = `${remote}/${branch}`;
    }
    if (!ref) return local(`Couldn't tell ${remote}'s default branch, so it started from your local HEAD.`);
  } else {
    const onRemote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${base}`]);
    ref = onRemote.ok ? `${remote}/${base}` : base;
  }

  const commit = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!commit.ok) throw new Error(`There's no ${ref} to start from.`);
  return { ref, commit: commit.out, note: "" };
}
