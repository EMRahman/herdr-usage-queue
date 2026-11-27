# Herdr Usage Queue

**Queue coding-agent jobs in the [Herdr desktop app](https://herdr.dev) and run them on whichever subscription has allowance to spare.**

Claude Code · Codex · Antigravity

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Herdr mod](https://img.shields.io/badge/Herdr-mod-2fbf71)](https://herdr.dev/gallery/?type=mods)
[![Runs on Bun](https://img.shields.io/badge/runs%20on-Bun-f9f1e1)](https://bun.sh)

![Usage Queue in the Herdr sidebar: three jobs ready to launch, one scheduled to launch by itself in 2h 10m, a traffic light per coding agent, and Fix flaky tests with its recommended model and effort](herdr-app/preview.png)

Subscriptions reset their allowance on a clock, and whatever is left when a window resets is
gone. Usage Queue holds jobs you'd like done, has a big model recommend the model and effort for
each, and launches them when you say so, or by themselves once there's allowance. It reads
allowance from [Usage Monitor](https://github.com/EMRahman/herdr-usage-monitor), which must be
installed.

See [DESIGN.md](DESIGN.md) for the design and what's still to come.

## The flow

1. **Add a job**: click **+** in the queue (title, prompt, repository, agents, priority), or
   write a JSON file into `~/.config/herdr-app/usage-queue/jobs/`.
2. **Estimate** (you approve it): open the job from **Pending Launch Approval**. Pick one of the
   big models that has allowance (one is suggested) and click **Estimate**. It reads the job,
   read-only, and recommends a model, thinking effort and size for each of the job's agents.
3. **Approve**: approve the proposal as is, or change the agent, model or effort first. The job
   moves to **Ready to Launch**.
4. **Launch**: click **Launch**, or **Auto** to launch as soon as there's allowance (with
   allowance now, Auto is the same as Launch). The queue fetches the repo and makes a new worktree
   on a `queue/<job>-<time>` branch from the remote's latest default branch (`origin/main`), then
   starts the agent there in a background space with the prompt as its first message.

5. **PR and reviews** (optional, set per job under "When it's done"): **Open a PR** has the agent
   open a pull request when it's done. The queue then checks it on GitHub every 2 minutes and
   sends new review comments back to the agent, up to 3 rounds, each ending in
   `@codex review`. **PR + merge on 👍** also merges it once it gets a 👍 (a 👍 reaction, an
   approving review, or Codex's "Didn't find any major issues"). New comments after the third
   round, or a failed merge, are handed to you with a notification.

6. **Wait for another job** (optional, in a Ready job's dialog under "Wait for"): the job won't
   launch, by Launch or Auto, until that job is finished: its PR merged, or, without a PR, its
   agent done. Launches fetch the remote's latest first, so the work goes on top of what was
   just merged. With Auto on, it launches by itself once both the job it waits for is finished
   and there's allowance. Its row reads "… · after <job>".

Editing a job file after approval sends it back to Pending Launch Approval.

## The lights

One per coding agent at the top of the queue, and one beside each job:

| Light | Meaning | Launch |
|---|---|---|
| 🟢 Ready | Allowance would reset unused if not spent | Yes |
| 🟡 Open | Above the reserve, but nothing is going to waste | Yes, it spends allowance you might want later |
| 🔴 Not yet | At or below the reserve (5h: 25%, weekly: 15%) | No |

Hover a light for the numbers.

## Install

```sh
bun herdr-app/install.ts            # into the layout on screen
bun herdr-app/install.ts --layout my-layout
```

It copies `herdr-app/mods/usage-queue/` into `~/.config/herdr-app/mods/` and adds a 230px block
to the sidebar of a personal layout (after Saved Prompts, or after the spaces and agents lists).
To remove it, delete the `usage-queue` block from the layout file and the mod folder.

## A job file

```json
{
  "about": "Find and fix flaky tests in myapp",
  "prompt": "Run the test suite 5 times, list tests that flip, and fix the top one.",
  "where": { "worktree": { "repo": "~/Code/myapp" } },
  "agents": ["claude", "codex"],
  "model": { "claude": "sonnet" },
  "effort": { "claude": "medium" },
  "priority": 2,
  "launch": "approve"
}
```

`model` and `effort` are optional: with both set for an agent, the estimate is skipped.
`"after"` is the id (file name) of a job to wait for. `"pr"` is `"off"` (default), `"review"` (open a PR and address reviews) or `"merge"` (and merge
it on a 👍); it needs the GitHub CLI (`gh`) signed in.

`"base"` is the commit the job starts from, taken at launch: `"remote"` (default: fetch, then the
remote's default branch, i.e. the repo's latest on GitHub), `"local"` (your checkout's HEAD,
unpushed work included), or a branch name (that branch on the remote, fetched). Without a remote,
or when the fetch fails, it starts from your local HEAD and the launch notification says so.

## Agents and models

Defaults are in `herdr-app/mods/usage-queue/catalog.js`. To change them, write
`~/.config/herdr-app/usage-queue/catalog.json`; each entry replaces the default agent's fields by id:

```json
{ "agents": [{ "id": "codex", "models": [{ "id": "gpt-6.2-astra", "label": "GPT-6.2 Astra", "tier": "big" }] }] }
```

Only `big` models run estimates. Antigravity models find their allowance group by their label.

## Files

| Path | What |
|---|---|
| `~/.config/herdr-app/usage-queue/jobs/*.json` | Job definitions |
| `~/.config/herdr-app/usage-queue/state.json` | Estimates, approvals, launches (the mod writes it) |
| `~/.config/herdr-app/usage-queue/history/*.jsonl` | Every event, append-only |

## Develop

```sh
bun test                                       # rule, catalog, estimates, queue, git base
herdr-app check herdr-app/mods/usage-queue     # loads the mod once
bun herdr-app/preview/render.ts                # redraws herdr-app/preview.png (needs Chrome)
```
