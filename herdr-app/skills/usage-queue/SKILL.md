---
name: usage-queue
description: Queue coding-agent jobs in Herdr's Usage Queue to run later, when a subscription has allowance to spare, and check on queued jobs. Use when the user asks to queue, defer, schedule for later, "do this when there's allowance", split work into follow-up jobs or PRs to run after each other, or asks what's in the queue or how a queued job is going.
---

# Usage Queue

Usage Queue (a Herdr app mod) holds jobs: a prompt, a repo, and which agents may do it. When
the user allocates a job (size, agent, model, effort) and launches it, or turns on Auto, the
queue starts a fresh agent in a new git worktree from the repo's latest on its remote, and can
open and shepherd a PR.

**You queue; the user allocates and launches.** A job you add appears in the queue as
"Needs allocation" and does nothing until the user acts on it in Herdr. Say so when you report
back.

## The command

```sh
{{cli}} <command> [options]
```

Always use it rather than writing job files by hand: it checks the job the way the queue reads
it, refuses a job that would never launch, and writes the file atomically.

| Command | Does |
|---|---|
| `add --prompt "…" --title "…"` | Queue a job. Prints its id. |
| `list` | Every job and where it is |
| `status <id>` | One job: allocation, launch, PR, recent history |
| `validate [<id>…]` | Check job files (all by default) |

Add `--json` to any command for machine-readable output. Exit code 1 means errors, 2 bad usage.

### add options

- `--prompt "…"`, `--prompt-file plan.md`, or `--prompt -` (stdin; best for long prompts, via a
  heredoc).
- `--title "…"`: short, imperative, under ~60 characters. Always give one.
- `--repo <path>`: defaults to the repo you're in. From inside a worktree it uses the main
  checkout, which outlives the worktree.
- `--agents claude,codex`: which agents may do it (default `claude`).
- `--model claude=sonnet --effort claude=medium`: prefill the allocation. Only when the user
  named a model or effort; otherwise the user sizes it or asks the queue to estimate.
- `--priority N`: 1 is highest, default 3.
- `--pr off|review|merge`: `review` has the agent open a PR and address review comments;
  `merge` also merges it on a 👍.
- `--permissions default|plan|edit`, `--base remote|local|<branch>`, `--auto`.
- `--after <id>`: wait until that job is finished (PR merged, or its agent done).
- `--dry-run`: check and print the file without writing it.

## How to queue well

1. **Write a self-contained prompt.** The job runs later, in a new agent with none of this
   conversation. Include the goal, the files or areas involved, what done looks like, how to
   check it (tests to run), and any decisions already made. Paths are relative to the repo root.
2. **Mind the starting point.** By default the job starts from the remote's default branch as
   it is at launch. Unpushed or uncommitted work here isn't there. If the job needs it, say so
   to the user (push first, or use `--base local`).
3. **Chains:** for work that must happen in order, add the first job, take the id it prints, and
   pass it as `--after` to the next. Each job then starts from the remote's latest once the
   previous one's PR is merged, so use `--pr review` (or `merge`) on all but possibly the last.
4. **Don't decide for the user** on `--auto`, `--pr merge`, `--permissions edit` or a model and
   effort unless they asked. These spend allowance or merge code without a click.
5. **Run with `--dry-run` first** when the job is non-trivial, then add it for real.
6. **Report back** with the id(s), the title(s), any `--after` chain, and that the jobs need
   allocating in Usage Queue (the sidebar block in Herdr) before they run.

## Checking on jobs

`list` shows each job's phase: `needs-allocation`, `saved`, `auto`, `waiting` (on another
job), `working`, `braked` (paused at the allowance reserve; it resumes by itself), `pr`,
`needs-you`, `done`. `status <id>` adds the branch, worktree folder, PR number and recent
events. Allowance (the traffic lights) is only shown in Herdr.

## Don't

- Don't touch the queue's `state.json` or `history/`: only the queue writes them.
- Don't edit a job that's been allocated: changing its file resets the allocation. Tell the user
  instead; they can **Edit prompt** in the job's dialog.
- Don't use `repeat`, `deadline` or `maxMinutes`: they aren't built yet, and `validate` warns
  about them.
