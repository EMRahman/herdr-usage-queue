# Usage Queue: design

Status: draft, revised 2026-11-27. Built (`herdr-app/mods/usage-queue/`): milestones 1 and 2,
and from milestone 4 Auto launch, done detection, PR reviews and cleanup after a merge. Not
built: milestone 3 (the contract), the [brake](#5-brake) and permission profiles.

**Usage Queue** is a Herdr app mod that holds a queue of agent jobs. When one of your
subscriptions has allowance that would otherwise reset unused, it proposes a job for it, with a
recommended model and thinking effort. You choose the allocation and click Launch, or enable
Auto to launch when allowance frees up. It is a
companion to
[Usage Monitor](https://github.com/EMRahman/herdr-usage-monitor): the monitor shows the
allowance, and the queue spends it.

> Queue jobs; they run on whichever subscription has allowance to spare.

## Why

Subscriptions (Claude Pro/Max, ChatGPT Plus/Pro for Codex, Antigravity, …) bill a flat fee and
limit use with rolling windows: usually a 5-hour session window and a weekly window. Allowance
that is left when a window resets is gone. Usage Monitor already flags that ("Untapped": at least
20 points more allowance left than time left), but nothing acts on it.

No existing Herdr scheduler does this. About 25 were reviewed (Nov 2026): DnzzL/herdr-automations,
kimsuhan/herdr-scheduler, mikedclarke/herdr-shepherd, tiagokriok/herdr-triggers and others. They
all fire on a clock or a webhook. Two can run a custom check before a job (Shepherd's `gate`,
kimsuhan's `poll` scripts), so a quota check could be bolted onto them. None of them reads
allowance, and none routes a job across providers.

## Goals

1. Hold a queue of jobs: a prompt, where it runs, and which agents may do it.
2. Start a job only when doing so spends allowance that would otherwise go unused, and never
   eat into a reserve kept for your own interactive work.
3. When several providers could take a job, pick the one whose spare allowance is lost soonest.
4. Make each decision visible: why a job ran now, on this provider, or why it is still waiting.
5. Recommend a model and thinking effort for each job, and launch only what you approved.

## Non-goals

- **Not cron.** A job has no fixed time. An optional `after`/`deadline` limits when it may run,
  but allowance decides the moment. Jobs on a clock belong in a cron mod.
- **Not the Message Batches API.** The API's batch discount applies to pay-per-token API usage.
  Subscription usage in Claude Code, Codex and others does not go through it.
- **Not a monitor.** Usage Queue does not fetch provider usage itself. It reads Usage Monitor's
  readings ([Data contract](#data-contract-with-usage-monitor)).
- **Not a workflow engine.** One job is one prompt in one agent session. No DAGs: a job can
  wait for one other job (`"after"`) to finish, and that's all.

## Key decisions

1. **Separate mod**, reading Usage Monitor through a published shared-state contract.
2. **Spend only projected waste, above a reserve.** Two gates per pool: *may* it spend
   (headroom above the reserve) and *should* it (allowance projected to reset unused).
3. **A pool's waste is its smallest spare across all its windows.** A short window's leftover
   is not lost while a longer window is behind pace.
4. **Even pace (v1), learned pace later.** v1 assumes you would use your whole allowance, so it
   only spends when you are clearly behind. Learning your real pattern is what later makes it
   spend more.
5. **One launch queue** ([Flow](#flow)). Each job appears there as soon as it is added.
   **Needs allocation** marks jobs that still need a launch configuration.
6. **Manual sizing by default.** A big model can recommend size, model and effort on request.
   A good recommendation saves more allowance than the estimate costs. No token predictions.
7. **The reserve is enforced while jobs run, not only at dispatch** ([Brake](#5-brake)).
8. **Interactive agents in Herdr panes, not headless runs.** You can watch, take over, and answer
   a permission prompt.
9. **Jobs are data**: one JSON file per job, worktree by default, never permission-skipping by
   default.
10. **JSON files now, a database later** ([Storage](#storage)): one storage module, versioned
    records, so moving to a database is a one-off import.
11. **App mod only for v1**; the rule and job format stay runtime-independent so a daemon can
    come later.

## Flow

Each job goes through these steps:

1. **Find allowance.** The [dispatch rule](#dispatch-rule) finds which pools are open and worth
   running, and which of the job's agents can draw on them.
2. **Set the allocation.** Open a **Needs allocation** row to choose Small, Medium or Large
   and set the agent, model and effort. **Estimate with a model** offers a recommendation
   on request ([Estimating](#estimating-model-and-effort)).
3. **Launch.** **Launch** or **Auto** saves the chosen allocation and starts or schedules the
   job. **Save allocation** keeps the choices for later. Each queue row shows whether its
   allowance permits a launch:
   - **Ready** (green): its pool is worth running; this allowance would otherwise reset unused.
   - **Open** (yellow): its pool is above the reserve but nothing is going to waste; launching
     spends allowance you might want later.
   - **Not yet** (red): its pool is closed, with the reason and when that changes ("weekly 4%
     left until 03:00").

   The job stays in the queue until it launches. With **Auto** enabled, it launches when there
   is allowance and any prerequisite job is finished.

Later, a setting makes approval automatic, per job or for the whole queue: the queue then
estimates, proposes and launches without asking.

## Why a companion, not part of Usage Monitor

- **Different risk.** Usage Monitor only reads and is safe to install anywhere. Usage Queue
  starts agents in your repos, unattended. People who want the gauge shouldn't get automation
  bundled with it.
- **A clean boundary already exists.** Usage Monitor's bridge produces a normalised report with
  every window's percentage and reset time.
- **One change to Usage Monitor:** it publishes its readings as a stable shared-state contract.
  Other mods can use that too.

## Background: what the readings look like

From `bridge.js --cached` at 2026-11-26 22:52 UTC (abridged):

| Provider | Window | Left | Resets in | Time left | Spare (left − time left) |
|---|---|---|---|---|---|
| Claude (Pro) | 5h session | 91% | 4.1h | 83% | +8 |
| Claude (Pro) | 7d weekly | **4%** | 4.1h | 2% | +2 |
| Codex (Plus) | 5h session | **0%** | 1.6h | 33% | −33 |
| Codex (Plus) | weekly | 54% | 5.7d | 82% | −28 |
| Antigravity: Gemini group | 5h | 74% | 1.4h | 27% | **+47** |
| Antigravity: Gemini group | weekly | 68% | 6.4d | 92% | −24 |
| Antigravity: Claude/GPT group | weekly | 50% | 6.4d | 92% | −42 |

Claude also holds one full limit reset (expires 2026-12-10) and Codex holds two.

What this example teaches:

- **The 5-hour window alone misleads.** Antigravity's Gemini 5h window is far under pace (+47),
  but its weekly window is behind pace (−24). Spending that 5h leftover now borrows from later in
  the week, so it is not waste. Hence "smallest spare across windows".
- **The binding window decides.** Claude's 5h window has 91% left, but the weekly window has 4%,
  below the weekly reserve. Claude is closed until both reset at 03:00 UTC.
- **Right now nothing should run.** Every pool is either nearly empty or behind pace on some
  window. The queue waits for a pool to fall behind on all its windows: a moment no cron line
  would name.
- **Providers split allowance by model group** (Antigravity). A route must name the group, not
  only the provider.

## Concepts

- **Provider**: a service with usage windows, from Usage Monitor's report: `claude`, `codex`,
  `antigravity`, `cursor`, `copilot`, `grok`, `opencode`, …
- **Pool**: one set of windows that a run draws on. Usually one account of a provider
  (`claude:personal`, `codex`); for Antigravity, a model group (`antigravity/gemini`). Several
  Claude accounts are separate pools.
- **Window**: `{ length, leftPct, resetsAt }`. `timeLeftPct = (resetsAt − now) / length`.
- **Route**: one way to start an agent, drawing on exactly one pool: the CLI, the model, the
  thinking effort, how to pass the prompt, and whatever selects the account. Built from Herdr's `knownAgents()` /
  `programs.json` plus overrides. Antigravity routes find their group from the group's `models`
  list.
- **Job**: what to do and where (see [Jobs](#jobs)). A job names agents (`claude`, meaning any
  Claude pool) or pins a pool (`claude:work`); the queue expands that into routes.
- **Proposal**: a job plus a route, model, effort and size, and the reason for each. It is made
  by the dispatch rule and the estimate, and launches once you approve it.
- **Reserve**: allowance that is never spent by the queue, per window kind (default 5h: 25%,
  weekly: 15%). Your interactive work keeps priority.

## Dispatch rule

Runs on every new reading, and on a 60s tick. The rule is a pure function
(pools + jobs + now → decision + reason), so it can be tested from recorded readings and reused
by a daemon.

### 1. Headroom: may the queue spend here?

```
headroom = min over the pool's windows w of (w.leftPct − reserve[w.kind])
```

A pool is **open** when headroom is above the job's expected cost, and **closed** otherwise.

### 2. Waste: should it spend here?

```
spare(w) = w.leftPct − w.timeLeftPct · expectedUse(w)   // projected leftover at reset
waste    = max(0, min over the pool's windows of spare(w))
urgency  = waste / hours until the binding window (the one with the smallest spare) resets
```

A pool is **worth running** when `waste ≥ MARGIN` (20, the same threshold as Usage Monitor's
Untapped light), or when its binding reset is less than `runBefore` (default 60 min) away and
waste covers a job.

`expectedUse` is 1 (even pace) in v1. That is deliberately conservative: it assumes you would
otherwise use your whole allowance. Learning your real pattern from Usage Monitor's history (you
rarely finish a week; weekdays are heavier than weekends) is the main way to let the queue spend
more, and comes after v1.

### 3. Propose a job and a route

- Jobs are taken by priority, then age.
- Among a job's routes whose pool is open and worth running, pick the highest `urgency`. Ties go
  to the order of the job's `agents` list.
- A job close to its `deadline` with no pool worth running may be proposed on any **open** pool,
  with the reason recorded as `deadline`. It still never goes below the reserve.
- The rule's output is a proposal and a readiness status (Ready, Open, Not yet). It launches
  only once approved, and then only when you click Launch or, with auto-launch, when it is
  Ready.

### 4. Limits

- **One running job per pool** at first (`concurrency` setting later).
- **Settle time**: after a dispatch, the pool is held for `settle` (default 10 min) or until a
  new reading arrives, because readings lag behind use.
- **Cost estimate**: each finished job records the drop in `leftPct` on its pool. Only runs
  where no other agent on the same provider was working in Herdr count, so your own work does
  not inflate it. The estimate is the median of recent clean runs (default 5 points before any
  history). It decides whether a job fits; it is not what protects the reserve.
- **Pause switch** stops every dispatch; jobs just stay queued.

### 5. Brake

Draft, 2026-11-27. Not built yet.

While a job runs, the queue keeps reading its pool. When the pool reaches its reserve, the queue
**interrupts** the agent: it presses the agent's stop key with `hc interrupt <terminal>`, as Esc
would. It doesn't kill the agent. The agent stays open in its space with its conversation, and
the worktree stays as it is. When the pool has allowance again, the queue tells the same agent
to carry on. Readings lag, so the brake can overshoot by about one reading; the reserve absorbs
that. This, not the cost estimate, is what makes the reserve a guarantee.

**What it watches.** Every job the queue launched, by Launch or Auto, that is still running:
`state.jobs[id].launched` has the pool, the terminal and the folder. An agent that isn't
`working` (idle, done, or blocked on a prompt) isn't spending, so it isn't touched.

**When it brakes.** On each reading (every 60 s), for the job's pool:

- **At the reserve:** headroom (the tightest window's `leftPct` minus its reserve) is 0 or less.
  Launches need 5 points of headroom (`MIN_JOB_COST`), so a job that starts near the line
  isn't braked at once.
- **Stale reading:** the reading is older than the light's staleness limit, so the queue can't
  tell whether the reserve is safe. This only works if readings keep coming while jobs run.
  Today the queue asks Usage Monitor for fresh readings only while a job is on Auto
  (`readReport(hasScheduled())`), so that becomes `hasScheduled() || hasRunning()`. Once
  milestone 3 ships, the consumer keepalive does the same job.
- Not when you said **Let it finish** for that job (below).

The pool's light can be red for your own work as much as the job's. That's the point: the
reserve is for you.

**How it brakes.**

1. `hc interrupt <terminal> --json`, which reports whether the agent stopped. Set
   `launched.braked = { at, reason, pool }`. Record a `braked` history event. Notify once:
   "Braked: <job>. Claude 5h is at its reserve (24% left). Resumes in about 2h 10m."
2. If the agent is still `working` on the next reading, try once more. After two attempts, stop
   trying and notify. Never kill the agent: that loses its context, and you can stop it yourself.

**While braked.**

- The row shows "Braked · resumes in 2h 10m" (the pool's `changesAt`), or "Braked · stale
  reading".
- **It isn't finished.** An interrupted agent goes idle, which today counts as finished for a
  job without a PR (`trackFinish`). That would wrongly let the jobs waiting on it launch. A
  braked job doesn't finish, and the "stopped without opening a PR" warning doesn't fire.
- **No review rounds.** Review rounds wait. `hc send` to a braked agent would start it spending
  again.
- **You can take over.** If the agent starts working without the queue resuming it, you typed to
  it. The brake mark is cleared, the job is marked `takenOver`, and it isn't braked again: you're
  driving it now.

**Resuming.** When the pool's light leaves red, the queue sends "The allowance is back. Carry on
where you left off." to the same agent (`hc send --if idle`). It clears `braked` and records
`resumed`. Resumes follow the same limits as Auto launches:

- one per pool per settle period (10 min), and a resume counts as a launch for that limit;
- jobs by priority;
- none while **Pause auto** is on.

If the agent is gone (its space closed, or Herdr restarted), a new agent starts in the same
worktree. It gets the job's prompt, prefixed with "Earlier work on this job is in this worktree
(branch <branch>): check `git status` and `git log` first." That's how `sendRound` already
replaces a missing agent.

**Let it finish.** A button in the launched job's dialog sets `launched.noBrake`. It's for when
you'd rather spend the reserve than lose momentum. New launches on that pool still wait.

**Code.** The decision is a pure function next to `dueToLaunch` in `queue.js`, tested from
recorded readings:

```
brakeSteps(jobs, state, pools, judged, agentStatus, now)
  → [{ job, step: "brake" | "retry" | "resume" | "restart" | "taken-over", reason }]
```

`main.js` runs the steps (`hc interrupt`, `hc send`, `space.new`) on the 60 s readings tick.

**Tests.**

- Braking and resuming:
  - brake at headroom 0 and when the reading is stale;
  - no brake for an idle or blocked agent, or with Let it finish;
  - retry, then give up;
  - resume when the light leaves red, one per pool per settle period, none while paused;
  - restart when the agent is gone;
  - taken over when it works without a resume.
- Jobs waiting on a braked one stay blocked.
- Review rounds wait while their job is braked.

**Not in this step.** `maxMinutes` (a time limit) can use the same interrupt later. Cost
learning comes later too: the drop from launch to brake is a lower bound on that run's cost.

### Held resets (later)

Claude and Codex can hold full limit resets. The queue never redeems them. When the queue is
backed up and a provider holds a reset that will expire, the panel suggests using it, with the
backlog size, and you decide.

## Estimating model and effort

- **On request.** The result stays on the job until you edit the file or estimate again.
  A job that pins `model` and `effort` opens with those values selected.
- **Big models only**, because picking the right model and effort takes judgement about the task
  and the repo. Estimators are a configured list of each provider's top model at high effort
  (e.g. Opus for Claude). Those on a closed pool are listed but can't be picked.
- **It suggests which to use**: the big model whose pool has the most waste, or the most headroom
  if nothing is going to waste. You can pick another.
- It runs as a one-shot headless call, and its cost is recorded like a job's. It recommends; you
  decide.
- **Output per route:** `{ model, effort, size: "s" | "m" | "l", why }`. It reads the job's
  prompt and takes a short look at the repo.
- **The smallest setup that does the job well**, stepping up when the pool's waste covers the
  bigger size: allowance that would reset unused costs nothing extra.
- **No token predictions.** Size maps to cost through what past runs of that size cost on that
  route ([Cost estimate](#4-limits)). The brake covers a bad guess.
- Effort maps to each agent's own setting (Claude Code's effort level, Codex's reasoning
  effort).

## Jobs

One JSON file per job in `~/.config/herdr-app/usage-queue/jobs/` ([Storage](#storage)). Data only, no code: the only thing a job
runs is the agent. One file per job is easy for an agent to write, and the mod never has to
rewrite a file you are editing. Job files are definitions only; status and history live in the
mod's own state.

```jsonc
// jobs/flaky-hunt.json
{
  "about": "Find and fix flaky tests in myapp.",
  "prompt": "Run the test suite 5 times, list tests that flip, and fix the top one. Open a PR.",
  "where": { "worktree": { "repo": "~/Code/myapp" } },  // default; or { "background": { "cwd" } } or { "space" }
  "agents": ["claude", "codex"],                         // or a pinned pool: "claude:work"
  "model": { "claude": "sonnet" },                       // optional pin; otherwise estimated
  "effort": { "claude": "medium" },                      // optional pin; otherwise estimated
  "launch": "approve",                                   // default; or "auto" (launch when allowance frees up)
  "permissions": "edit",                                 // profile each route maps to its agent's own flags
  "priority": 2,                                         // 1 = highest
  "repeat": "weekly",                                    // optional: re-queue after it runs
  "deadline": "2026-12-05",                              // optional
  "maxMinutes": 45                                       // stop and mark timed out
}
```

A job that runs once leaves the queue when it ends. A repeating job is re-queued no earlier than
its `repeat` period after its last run, and still waits for allowance. It keeps its saved allocation.
`"launch": "auto"` in the file enables Auto on **Save allocation**. The estimate and
allocation live in state.

## Running a job

- **Interactive, in a pane.** Agents run as their normal TUI in a Herdr pane, not headless
  (`claude -p`, `codex exec`). You can peek, take over, or answer a permission prompt, and Herdr
  already tracks agent state. The cost: "done" comes from agent state, not an exit code.
- **Start**: through Herdr app commands and `hc`, as the existing app schedulers do:
  - worktree (default): Herdr's `worktree` mod `{branch, argv}` under
    `<worktrees.directory>/<repo>/`, branch `queue/<job>-<timestamp>`;
  - background: `hc run --keep --cwd <dir> --label herdr-usage-queue.job=<id> -- <argv>`, no tab;
  - space: `space.new {folder, argv, focus: false}`.
  Nothing takes focus.
- **Prompt delivery**: as an argv argument where the agent supports it (`claude "<prompt>"`,
  `codex "<prompt>"`), otherwise typed in once the agent reports `idle`.
- **Done**: the agent reported `done`/`idle` after its first `working`, and nothing has worked
  for 30s. **Blocked**: the agent reports `blocked` (a permission prompt); the job stays
  `blocked`, a toast says so, and its pool slot stays taken until you answer or `maxMinutes`
  passes.
- **History**: append-only JSONL per day:
  `queued → dispatched(pool, reason, readings) → running → done | failed | blocked | stopped | timedout`.

## Storage

JSON files for v1, built so they can move to a database (likely SQLite) later.

| Data | Where | Written by |
|---|---|---|
| Job definitions | `jobs/<id>.json` | You, the form, or an agent |
| Current state per job: estimate, proposal, approval, auto-launch, status, timestamps | `state.json` | Only the mod |
| Events: estimated, approved, launched, finished, cost | `history/<date>.jsonl`, append-only | Only the mod |
| Agent and model overrides (optional) | `catalog.json` | You |

All in `~/.config/herdr-app/usage-queue/`: outside `mods/`, because Herdr reloads a mod whenever
a file in its folder changes, and inside the app home, where mods may write files.

- **One writer.** Only the mod writes state and history. `state.json` is written to a temp file
  and renamed, so a crash can't leave it half-written.
- **Allocation applies to one version of a job.** The allocation stores a hash of the job file.
  If the file changes, the queue shows **Needs allocation** and Auto requires a new allocation.
- **Ready to move to a database.** All reads and writes go through one small storage module, so
  swapping files for a database changes only that module. Every record carries a `version` and
  a stable job id, and every event has a timestamp. Moving to a database is then a one-off
  import of `jobs/`, `state.json` and `history/`.
- **When to move:** when the daemon arrives (two writers), or when the history gets too big to
  scan.

## Data contract with Usage Monitor

Usage Monitor publishes, after every reading:

```ts
shared("usage-monitor.windows") = {
  version: 1,
  readAt: number,                  // ms epoch of the newest reading
  pools: Array<{
    id: string,                    // "claude:personal", "codex", "antigravity/gemini"
    provider: string,              // "claude" | "codex" | "antigravity" | …
    account?: string,
    plan?: string,
    readAt: number,                // this pool's reading; stale when old
    models?: string[],             // for model-group pools
    windows: Array<{
      kind: "5h" | "weekly" | "daily" | "monthly" | "other",
      label: string,
      leftPct: number,             // 0–100
      resetsAt: string | null,     // ISO
      lengthMs: number | null,
      light: "untapped" | "on-pace" | "tight" | null,   // display only
    }>,
    heldResets?: Array<{ id: string, label: string, expiresAt: string | null, usableNow: boolean }>,
  }>,
}
```

- **Raw numbers, not verdicts.** The queue computes its own rule from `leftPct`, `resetsAt` and
  `lengthMs`. `light` is there for display; the queue does not depend on Usage Monitor's pacing
  logic.
- `account` holds the email as Usage Monitor shows it. Usage Queue only shows it locally.
- **Stale readings**: a stale pool is treated as closed, and a running job on it is braked.
- **Freshness**: Usage Monitor polls only while its readout is visible. Decision: it keeps a slow
  poll while any consumer is registered (`shared("usage-monitor.consumers")`), so the queue
  never calls the provider APIs itself.
- **Fallback** while the contract doesn't exist: `exec("bun", [bridge.js, "--cached"])` and
  normalise the report. For development only.

## UI

**Launch queue** is a single sidebar list. Jobs appear by priority, with dependent jobs grouped
under **Waiting for another job**. A row shows **Needs allocation** or launch controls for its
saved allocation. The job dialog shows manual size choices and an optional estimate.
**Launched** appears below the queue with recent launches and PR statuses.

- **A traffic light per coding agent** (Claude, Codex, Antigravity, …):
  - **Green (Ready)**: allowance would reset unused.
  - **Yellow (Open)**: above the reserve, but nothing is going to waste. Launching spends
    allowance you might want later.
  - **Red (Not yet)**: at or below the reserve.

  An agent with several pools (two Claude accounts, Antigravity's model groups) shows its best
  light and expands into one light per pool. Hovering shows headroom, waste and next reset.
- **Add job**: a form (prompt, where, agents, permissions, priority, deadline, repeat), plus a
  prompt that has an agent write a job file with you.
- **Pause** switch.

A possible status-bar item is `1 needs allocation · 2 ready · 1 running`.

## Safety

- Every unattended run is a new agent with the permissions its job's profile gives it. Worktree
  is the default. Starting with `--dangerously-skip-permissions` (or similar) is never a default.
- The reserve is enforced in code, at dispatch and by the brake. No job and no deadline can
  spend below it.
- Provider terms: automated use of a consumer subscription may be limited by a provider's terms.
  Check each provider's terms before turning on unattended runs for it. Usage Queue only starts
  the same CLIs you would start by hand, at your request.

## Desktop app only, or a daemon?

| | App mod only (like kimsuhan/herdr-scheduler) | Mod + login service (like herdr-automations, Shepherd) |
|---|---|---|
| Runs while Herdr is closed | No | Yes |
| Install | Copy a folder | Binary + launchd + mod |
| Readings | Shared state, in process | Must read a file Usage Monitor writes |
| Overnight resets | Only if Herdr is open | Yes |

Version 1: **app mod only**, because Herdr is usually open and the install is simpler. The rule
and the job format must not depend on the mod runtime, so a daemon can be added later.

## Open questions

1. How should `expectedUse` be learned: per weekday from Usage Monitor's history, or a single
   "share of the week you usually use"?
2. Name check: "Usage Queue" / `herdr-usage-queue`. Alternative: "Untapped".

## Milestones

1. **Find allowance** (built): pure `rule.js` with tests from real readings, and a traffic light
   per coding agent. Readings through the bridge fallback.
2. **Allocate and launch** (built): one Launch queue with readiness, manual sizing and optional
   estimates, the add-job form, and manual Launch into a worktree in a
   background space. You watch it; no brake or done detection yet. History JSONL is written.
3. **Contract**: Usage Monitor publishes `usage-monitor.windows` (+ consumers keepalive), so
   readings keep coming while its readout is hidden.
4. **Auto-launch**: the auto-launch toggle and `"launch": "auto"`. This is the first unattended
   run, so it brings done detection, the brake and permission profiles. Built: Auto, done
   detection (agent idle, PR merged, Mark finished), PR review rounds, cleanup after a merge.
   Not built: the [brake](#5-brake) (drafted) and permission profiles.
5. Job-writing prompt, cost learning per size and route, repeat and deadline,
   background and space runs.
6. Later: global auto approval, learned `expectedUse`, daemon mode (with the move to a
   database), held-reset suggestions.
