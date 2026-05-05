# Scheduler v2.5 — Manager Agent

## Vision

Right now you are the manager. You decide which model runs a task, in what order, whether it needs a worktree, and whether something is ready to execute. That works, but it means you have to follow up.

v2.5 replaces you in that role with a **Manager Agent**: a small Claude-based agent that watches the queue at a configured interval, classifies incoming tasks, routes them to the right runner, orders them intelligently, and keeps you informed — without you touching anything after the initial brain-dump.

The goal is: you define a pile of intent. The Manager turns that into an ordered, routed, tracked execution plan and runs it to completion.

---

## Current Model (v2.0)

```
User → [define task + pick runner + pick priority] → Queue → Worker → Runner → Done
```

The user is doing three jobs:
1. **Classification** — what kind of task is this?
2. **Routing** — which model/runner should run it?
3. **Ordering** — what's the right stack order?

These are all judgment calls that a capable small model can make reasonably well given some context about the project and the queue.

---

## v2.5 Model

Two modes. User picks via a settings toggle.

### Direct Mode (current behavior, default)

```
User → [task, dir] → Queue → Worker → Runner → Done
```

Runner is user-specified. Manager is not involved. No change.

### Manager Mode (new)

```
User → [task, dir, intent] → Inbox Queue
                                   ↓
                          Manager Agent (polls every N min)
                          ├─ classifies task
                          ├─ assigns runner
                          ├─ sets priority
                          ├─ sets worktree flag
                          ├─ annotates with reasoning
                          └─ promotes to Worker Queue
                                   ↓
                          Worker → Runner → Done
                                   ↓
                          Manager (on next poll)
                          ├─ reads finalMessage
                          ├─ checks for failures
                          ├─ queues follow-up tasks if needed
                          └─ posts completion summary
```

The Manager is the only thing that promotes tasks from Inbox to Worker Queue. The worker doesn't know the difference — it just sees a normal pending task with a runner already assigned.

---

## Manager Agent Design

### What it is

The Manager Agent is a Claude Haiku instance (fast, cheap, good enough for meta-work) that runs on a cron schedule — independently of the worker poll loop. It does not edit code. It manages the queue.

It runs as a special runner type: `manager`. When triggered, the manager runner:
1. Reads the full queue state via Scheduler's own REST API
2. Reads usage status for all providers
3. Makes routing and ordering decisions
4. Writes those decisions back via the same API

This is self-hosting: the Manager Agent talks to `localhost:3747` just like the UI does.

### System Prompt (draft)

```
You are the Scheduler Manager Agent for an engineering workstation. Your job is to
manage a queue of AI coding tasks and route them to the right execution model.

You have access to the Scheduler API (localhost:3747) via HTTP tool calls. Use it to:
- read inbox tasks waiting for routing
- read usage status for Claude and Codex
- read the current worker queue and its state
- create routed tasks in the worker queue
- annotate tasks with your reasoning
- cancel or reorder tasks when appropriate

Routing rules:
- UI work, design changes, visual debugging → claude-sonnet (best visual reasoning)
- Tight algorithmic code, performance work, large refactors → codex-gpt-5.4 or claude-opus
- Documentation, README updates, renaming, formatting → claude-haiku (fast, cheap)
- Simple bug fixes with clear reproduction → claude-sonnet
- Unknown or complex multi-step → claude-sonnet, use worktree

Ordering rules:
- Foundational changes before dependent changes
- Failing tasks that block other tasks: highest priority
- Tests and CI fixes: high priority (they gate everything else)
- Docs and cosmetic work: lowest priority
- Respect explicit user-set priority overrides

Worktree rules:
- Enable worktree if: multi-file refactor, uncertain outcome, touches shared state
- Disable worktree if: single-file fix, docs-only, low risk

When done, post a brief routing summary as a comment on the inbox queue entry.
Always explain your reasoning in one sentence per decision.
```

### Tool Access

The Manager Agent's tools are the Scheduler's own API endpoints, wrapped as callable functions. In the initial implementation this is done with simple `curl` calls from within the manager runner shell script. In v3 this becomes a proper MCP server.

**Read tools:**
- `get_inbox()` → `GET /api/tasks?status=inbox`
- `get_queue()` → `GET /api/queue?status=pending`
- `get_usage()` → `GET /api/usage`
- `get_worker_status()` → `GET /api/status`
- `get_project_summary()` → `GET /api/projects/summary`
- `get_task(id)` → `GET /api/tasks/:id`

**Write tools:**
- `create_task(task, dir, runner, priority, worktree, reasoning)` → `POST /api/tasks`
- `update_task(id, priority, runner, worktree)` → `PATCH /api/tasks/:id`
- `annotate_task(id, managerNote)` → `PATCH /api/tasks/:id` (sets `managerNote` field)
- `cancel_task(id)` → `DELETE /api/tasks/:id`
- `requeue_task(id)` → `POST /api/tasks/:id/requeue`
- `create_scheduled(task, dir, runner, scheduledFor)` → `POST /api/scheduled`

---

## Intelligent Routing

### Classification Heuristics

The Manager classifies each task along three axes before routing:

| Axis | Options | Signal |
|------|---------|--------|
| Complexity | simple / moderate / complex | length, number of files mentioned, "refactor", "rewrite" |
| Domain | ui / logic / infra / docs / test | keywords, file extensions mentioned |
| Risk | low / medium / high | "delete", "migrate", "breaking", mentions of shared state |

### Routing Table

| Domain | Complexity | Recommended Runner |
|--------|------------|-------------------|
| docs / comments / rename | any | claude-haiku |
| ui / visual | any | claude-sonnet |
| logic / test / infra | simple | claude-sonnet |
| logic / test / infra | moderate | claude-sonnet |
| logic | complex | claude-opus or codex-gpt-5.4 |
| infra / migration | complex | codex-gpt-5.4 (deterministic, large context) |
| unknown | any | claude-sonnet |

### Usage-Aware Routing

If Claude's 5h window is below 30%, the Manager:
- Downgrades pending `claude-sonnet` tasks to `claude-haiku` where complexity allows
- Routes new `complex` tasks to `codex-gpt-5.4` if Codex budget is healthy
- Defers high-complexity tasks with `minUsagePct: 40` if both budgets are low

The Manager reads `/api/usage` on every poll cycle before making routing decisions.

### Worktree Decision

Manager enables worktree for a task if any of the following are true:
- Task mentions "refactor", "rewrite", "restructure", "migrate"
- Task affects more than one conceptual module (inferred from description)
- Task risk classification is `high`
- The same directory has a task currently running (isolation prevents conflict)

---

## Manager Queue Mode

### Settings Toggle

`configs/schedule.json` gains a new key:

```json
{
  "managerAgent": {
    "enabled": false,
    "model": "claude-haiku-4-5-20251001",
    "pollIntervalMinutes": 10,
    "autoRoute": true,
    "autoOrder": true,
    "autoWorktree": true,
    "notifyOnComplete": false,
    "dryRun": false
  }
}
```

When `enabled: true`, the Settings UI shows Manager status. The task submission form gains a small indicator: "Tasks will be routed by Manager Agent."

`dryRun: true` means the Manager annotates tasks with its routing decisions but does not actually move them — useful for building trust before handing over control.

### Task Lifecycle in Manager Mode

A new `status` value: **`inbox`**

```
pending (inbox=true) → [Manager evaluates] → pending (inbox=false, runner assigned) → running → done
```

When a user submits a task without specifying a runner, it lands with `status: pending, inbox: true`. The worker poll loop skips `inbox: true` tasks — they are invisible to the worker until the Manager promotes them.

The Manager reads all `inbox: true` tasks, decides routing, then patches each record with:
- `runner`: the assigned runner name
- `priority`: adjusted priority
- `worktree`: true/false
- `inbox`: false (promotes it to the worker queue)
- `managerNote`: one-line explanation of the routing decision
- `managerRoutedAt`: timestamp

If the user explicitly specifies a runner in the submission form, the task skips the inbox and goes directly to the worker queue.

---

## Manager as Autonomous Orchestrator

Beyond routing, the Manager can operate as a goal-completion system. On each poll cycle it:

1. **Reviews recent completions.** Reads tasks completed since last poll. Extracts `finalMessage`. Checks for failures.

2. **Handles failures.** If a task failed and the failure looks recoverable (e.g., rate limit, transient error), requeues it. If the failure looks structural, annotates it and optionally creates a "diagnose this failure" task routed to claude-haiku.

3. **Chains follow-ups.** If a task's `finalMessage` contains signals like "tests failing", "PR created", "merge conflict", the Manager can queue a follow-up task without user intervention. These follow-up rules are configured in `managerAgent.followUpRules` (see Config below).

4. **Orders the queue.** Reorders pending tasks by dependency signals in their descriptions. Tasks that say "after X" or "then" get lower priority than the tasks they depend on.

5. **Posts a summary.** If `notifyOnComplete: true`, writes a brief digest of what completed, what failed, and what's pending to a configurable endpoint (webhook or file).

---

## Self-Hosting Architecture

The Manager Agent is itself a runner inside the Scheduler. It runs on a separate cron trigger, not on the worker's poll loop. This means:

```
Worker Poll Loop (every 60s)     Manager Poll Loop (every N min)
├─ promotes scheduled tasks      ├─ reads inbox tasks
├─ checks window + usage         ├─ classifies + routes
├─ runs one worker task          ├─ reorders queue
└─ updates task record           ├─ handles failures
                                 ├─ chains follow-ups
                                 └─ writes annotations
```

The Manager never blocks the worker and the worker never blocks the Manager.

The Manager runner script (`src/runners/manager.sh`) looks like any other runner:
- Receives `TASK_TEXT` containing a JSON snapshot of what to do this cycle
- Invokes `claude --model $MODEL` with the manager system prompt
- Tools are implemented as bash functions that call `curl localhost:3747/...`
- Output is parsed for routing decisions and applied via API calls

"Dog eating its own tail" concern: the Manager talks to the same server it lives in. This is fine because the Manager is read-mostly and its writes are simple JSON patches. There is no recursive spawn risk — the Manager does not queue tasks for itself.

---

## Implementation Phases

### Phase 1 — Dry-Run Routing (2-3 days)

Goal: Manager reads the queue and annotates it. No actual routing yet.

- Add `inbox` boolean to task schema
- Add `managerNote`, `managerRoutedAt` fields to task schema  
- Add `GET /api/tasks?inbox=true` filter
- Create `src/runners/manager.sh` with read-only API access
- Implement classification + routing logic in manager system prompt
- Wire `dryRun: true` mode: Manager patches tasks with `managerNote` only
- Show `managerNote` in task detail UI (small italicized annotation)
- Add Manager status section to `admin.html`

### Phase 2 — Manager Queue Mode (2-3 days)

Goal: Manager actually promotes tasks. Worker respects inbox flag.

- Worker poll loop skips tasks with `inbox: true`
- Manager patches `inbox: false` + `runner` + `priority` + `worktree` on routed tasks
- Add manager toggle to Settings UI
- Add `managerAgent` block to config schema + validation
- Task submission form: if no runner selected and manager enabled, submit as inbox task
- Test: submit 5 tasks without runners, verify Manager routes them correctly

### Phase 3 — Autonomous Orchestrator (1 week)

Goal: Manager handles failures, chains follow-ups, keeps the queue moving.

- Implement failure detection: read failed tasks from last N hours
- Implement requeue logic for recoverable failures
- Implement follow-up task creation based on `finalMessage` signals
- Add `managerAgent.followUpRules` to config (see Config section)
- Add queue reordering: Manager can `PATCH /api/tasks/:id` to adjust priority
- Add Manager cycle summary log (written to `data/manager-log.jsonl`)
- Add Manager log view to admin.html

### Phase 4 — MCP Server (future)

Goal: Manager tools become a proper MCP server, enabling any MCP-compatible agent to orchestrate the Scheduler.

- Create `src/mcp/server.js` implementing the MCP protocol over the Scheduler API
- Expose all Manager tools as MCP tool definitions
- Register MCP server in Claude Code's `mcp.json`
- Manager runner switches from `curl` calls to MCP tool calls
- Any Claude Code session can now call `scheduler.get_queue()`, `scheduler.create_task()`, etc.

---

## Config Changes

### New fields in `configs/schedule.json`

```jsonc
{
  // existing fields unchanged...
  
  "managerAgent": {
    // Whether the Manager is active
    "enabled": false,
    
    // Which model the Manager uses
    "model": "claude-haiku-4-5-20251001",
    
    // How often the Manager polls (in minutes)
    "pollIntervalMinutes": 10,
    
    // Whether to auto-assign runner based on classification
    "autoRoute": true,
    
    // Whether to auto-adjust priority based on dependency analysis
    "autoOrder": true,
    
    // Whether to auto-set worktree flag
    "autoWorktree": true,
    
    // If true: annotate decisions but don't actually promote tasks
    "dryRun": false,
    
    // Max tasks the Manager will route per poll cycle
    "maxRoutedPerCycle": 5,
    
    // Rules for automatic follow-up task creation
    "followUpRules": [
      {
        "trigger": "finalMessage contains 'tests failing'",
        "action": "create_task",
        "taskTemplate": "Fix failing tests in {dir}. Previous attempt: {finalMessage}",
        "runner": "claude-sonnet",
        "priority": 10
      },
      {
        "trigger": "status == 'failed' and error contains 'rate limit'",
        "action": "requeue",
        "delayMinutes": 60
      }
    ]
  }
}
```

---

## API Changes

### New fields on task records

```jsonc
{
  // existing fields unchanged...
  
  // True if task is in the Manager's inbox, waiting for routing
  "inbox": false,
  
  // Manager's one-line routing explanation
  "managerNote": null,
  
  // When the Manager routed this task
  "managerRoutedAt": null,
  
  // Classification the Manager assigned
  "managerClassification": null  // { domain, complexity, risk }
}
```

### New endpoints

```
GET  /api/tasks?inbox=true          List tasks awaiting Manager routing
GET  /api/manager/status            Manager poll state, last cycle summary
GET  /api/manager/log               Last N manager cycle records
POST /api/manager/poll              Trigger an immediate Manager cycle
```

### Modified endpoints

```
POST /api/tasks
  body gains: { inbox?: boolean }
  If inbox: true and managerAgent.enabled: true, task is held for Manager routing.
  If runner is explicitly set, inbox is forced false (user override).
```

---

## UI Changes

### Task Submission Form

- Runner selector: add "Auto (Manager)" option at top when manager is enabled
- Selecting "Auto" sets `inbox: true` on submission
- Form shows pill: "Manager Agent active" when enabled in settings

### Queue View

- Tasks with `inbox: true` show a small "Inbox" badge instead of "Pending"
- Tasks with `managerNote` show a small annotation icon; tapping reveals the note

### Admin / Manager Status Section (new in `admin.html`)

```
Manager Agent                           [Enabled] [Trigger Now]
Last poll: 3 minutes ago
Last cycle: routed 4 tasks, requeued 1 failure, no follow-ups created
Next poll: in 7 minutes
Model: claude-haiku-4-5-20251001
Mode: Active (dryRun: false)
```

### Settings

- Manager Agent section with: enabled toggle, model selector, poll interval, dry-run toggle
- Follow-up rules editor (simple list, future)

---

## Open Questions

**1. Manager authority scope**
Should the Manager be able to cancel tasks, or only route/annotate/reorder? Starting with no cancel authority is safer — the user can always cancel manually. Revisit after Phase 2.

**2. Multiple managers**
Could there be a Claude manager for creative/UI routing and a cheaper rule-based router for docs? Probably overkill for v2.5. One manager, one model.

**3. Manager failure handling**
If the Manager itself fails (API error, model error), the inbox just sits. We need a fallback: after N minutes in inbox without routing, auto-promote with the default runner (claude-sonnet). This prevents the inbox from becoming a black hole.

**4. Context window and queue size**
With hundreds of tasks, sending the full queue to the Manager is expensive and slow. The Manager should only receive: inbox tasks (unrouted), recently failed tasks, and a summary of queue depth by runner. It does not need to see done/cancelled history on every cycle.

**5. User override after Manager routing**
If the Manager routes a task to `claude-haiku` but the user wants `claude-sonnet`, they should be able to change it from the task detail view. The Manager should not re-route already-routed tasks unless they are re-queued.

**6. Trust calibration**
Some users will not want an agent touching their queue without explicit confirmation. The `dryRun` mode addresses this. Consider a middle mode: `requireApproval` — Manager annotates tasks and surfaces them for one-tap approval in the UI before promotion.

---

## Relationship to FEATURE_WISHLIST.md

This spec implements the **Agent Supervisor** item (item 6 in FEATURE_WISHLIST.md) but reframes it: rather than a one-off supervisor mode you invoke with prompts, the Manager Agent is always-on infrastructure. It replaces the user in the orchestration role rather than adding a new interaction mode on top.

It also sets the foundation for:
- **Phase E** items: follow-up automations, task chaining, capture inbox
- **Resource Lanes** (item 8): Manager can direct tasks to Claude vs. Codex lanes explicitly
- **Dependencies** (item 9): Manager's follow-up rules are a v1 of task chaining
- **MCP layer** (Phase 4): the same tool set the Manager uses becomes available to any MCP client

---

## Summary

v2.5 is a single shift: the Manager Agent takes the orchestration work off the user's plate. The user submits intent; the Manager decides how to execute it. The underlying execution infrastructure — worker, runners, worktrees, usage gates — is unchanged. What changes is who is stacking the queue and routing the work.

Start with dry-run mode. Build trust. Then hand over routing. Then hand over follow-ups. The transition from "I am the manager" to "I review what the manager did" should feel gradual and reversible.
