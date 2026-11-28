# Agents queueing jobs: what works today, and what to build next

Report only: nothing in the mod changes with this file. Written 2026-11-28 against `main` at
3e405c4 ("Point to the next waiting job in the queue").

## Short answer

**Yes, an agent can queue a job today, but it can't schedule one.** Any agent that can write a
file can drop a JSON job into `~/.config/herdr-app/usage-queue/jobs/`, and it shows up in the
sidebar without a restart. A person still has to open it and allocate it (Save allocation, Auto
or Launch) before it runs. That's a sensible safety line, but around it the agent works blind:
nothing tells it the job format, nothing tells it the job was rejected or what happened to it,
and several fields shown in the docs are silently ignored.

## What I checked

| Claim | Where | Verdict |
|---|---|---|
| Job files written by an agent appear live | `main.js:1008-1015` (`watchFolder(paths().jobs)` then `reloadJobs()`) | ✅ Works |
| Required fields are `prompt` and a repo; everything else has defaults | `queue.js:10-41` (`readJob`) | ✅ Works |
| `model` + `effort` in the file prefill the route | `queue.js:308-318` (`pinnedRoute`) | ✅ Prefilled, but still **Needs allocation** |
| `"launch": "auto"` launches by itself | `main.js:1361` | ⚠️ Only once a person clicks **Save allocation** |
| `"after"` makes a job wait | `queue.js:251-264` (`blockedBy`) | ⚠️ An unknown id doesn't block: "A job that's gone doesn't hold anything up" |
| Loops in `after` are prevented | `queue.js:268-281` (`canWaitFor`) | ⚠️ Only in the dialog's chips; a file can write `a → b → a` |
| A bad job file is reported | `store.js` `loadJobs` → `problems` | ⚠️ Shown as a red sidebar row only; the agent that wrote it never sees it |
| `repeat`, `deadline`, `maxMinutes`, `where.background`, `where.space` | DESIGN.md job example | ❌ Not read anywhere in the mod; silently dropped |
| "A prompt that has an agent write a job file with you" | DESIGN.md, UI section | ❌ Not built |
| Milestone 5: a model turns details into a queued job | DESIGN.md, Milestones | 🟡 Only the title suggestion is built |

## Suggestions, most useful first

### 1. Give agents the job format as a skill (small, high leverage)

An agent asked to "queue this for later" currently has to guess the folder, the schema, the id
rules and the repo path. Ship a `usage-queue` skill (or a `SKILL.md` in the repo plus an install
step) that says:

- where job files go, and to write them atomically (write `<id>.json.tmp`, then rename), since
  the folder watcher can fire on a half-written file;
- the schema, with only fields the mod actually reads;
- how to pick an id (`jobId()`'s slug-plus-time shape) and how to look up the ids of existing
  jobs for `after`;
- "never set `permissions` beyond what the person asked for; the person allocates".

This alone turns "possible" into "reliable" for Claude Code, Codex and Antigravity.

### 2. A CLI: `usage-queue add | list | status | validate` (medium)

Writing JSON by hand is the weakest part of the agent path. A small Bun script next to
`install.ts` (`bun herdr-app/queue.ts add --repo . --prompt-file plan.md --after fix-auth-…`)
that:

- validates with the same `readJob` the mod uses, and prints the error, so a bad file never
  lands;
- checks that `after` names a real job and doesn't close a loop (reuse `canWaitFor`);
- writes the file atomically and prints the id;
- `list` / `status <id>` read `jobs/` and `state.json` and print each job's phase: needs
  allocation, auto, waiting on X, launched, PR #n round k, merged, braked.

`queue.js` is already pure, so this is mostly glue. It also gives the skill in (1) one command
to call instead of a format to remember.

### 3. Tell the writer when a job file is rejected (small)

Today `problems` only become a red sidebar row. Also:

- write `jobs/<id>.error.txt` (or a `problems` map in `state.json`) with the reason, so an agent
  can read it back;
- warn on fields that are ignored (`repeat`, `deadline`, `maxMinutes`, `where.background`)
  instead of accepting them silently;
- treat an `after` that names no job as an error ("Waits for `fix-auth`, but there's no such
  job") rather than as "nothing to wait for". A typo currently launches the job early, which is
  the most surprising failure for an agent-built chain.

### 4. Let an agent queue a chain in one go (medium)

The agent case that's begging to exist: "split this plan into 4 PRs and queue them in order".
That needs either several files with `after` links written in the right order (fragile, see 3),
or one file that holds a list:

```json
{ "chain": [
  { "about": "Add the schema", "prompt": "…" },
  { "about": "Migrate readers", "prompt": "…" },
  { "about": "Remove the old field", "prompt": "…" }
], "where": { "worktree": { "repo": "~/Code/myapp" } }, "pr": "review" }
```

The mod expands it into jobs with `after` set, shared fields inherited. The dependency map
already draws the result. Note DESIGN.md's non-goal ("No DAGs: a job can wait for one other
job"): a chain stays within that.

### 5. Hand-off back to the agent that queued it (medium)

Record who queued a job (`"queuedBy": { "agent": "claude", "terminal": "…" }`, filled by the
CLI or skill). When the job finishes, merges, gets braked or needs you, `hc send` a one-line
note to that terminal if it's still open (the review sender already does this kind of send).
The parent agent can then queue the next step or summarise for you, instead of you relaying.

### 6. An opt-in "trusted agent" allocation path (larger, needs a decision)

Right now every agent-written job waits for a click. DESIGN.md already plans "global auto
approval" for milestone 6. A narrower first step that fits agents:

- a per-repo or per-source allowlist in a settings file the agent can't write
  (`auto: { repos: ["~/Code/myapp"], maxSize: "m", permissions: ["plan", "edit"] }`);
- jobs from an allowed source with a pinned model and effort get their allocation saved
  automatically and go on Auto; everything else still needs a click;
- the allowance brake and reserve still apply, so the worst case is bounded.

This keeps "the person decides" as the default while letting a trusted planning agent fill the
overnight queue.

### 7. Agent-facing estimate (small, once 2 exists)

`usage-queue estimate <id>` runs the same estimate as **Estimate with a model** and stores it,
so an agent that queued a job can also leave a recommended size, model and effort ready for you
to accept with one click.

### 8. Build or drop the documented-but-unread fields

`repeat`, `deadline`, `maxMinutes` and the `background` / `space` targets appear in DESIGN.md's
job example. An agent reading the design will use them and get nothing. Either build them
(`maxMinutes` can reuse the brake's `hc interrupt`; `deadline` is already in the dispatch rule's
text) or mark them "not yet" in the example. Marking them is a five-minute change worth doing
regardless.

### Smaller ideas

- **Prompt from a file**: `"promptFile": "docs/plan.md"` relative to the repo, read at launch,
  so an agent can queue "carry out this plan" without pasting a long plan into JSON.
- **Context hand-over**: an optional `"context"` field (links, file paths, the parent PR)
  appended to the first message, so the launched agent doesn't rediscover what the queuing
  agent knew.
- **Status line**: DESIGN.md's `1 needs allocation · 2 ready · 1 running` as a shared-state key
  (`usage-queue.summary`) another mod or agent can read.
- **Bulk allocate**: when an agent queues five jobs, a "Allocate all with their pinned routes"
  button saves five dialog trips.

## Suggested order

1. Mark unread fields as "not yet" in DESIGN.md (8) and make an unknown `after` an error (3).
2. CLI with `add` / `validate` / `status` (2), then the skill on top of it (1).
3. Chains (4) and the hand-off note (5).
4. The trusted-agent allocation path (6), once you've decided how much to let agents launch
   without a click.
