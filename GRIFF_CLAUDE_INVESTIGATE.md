# Griff Claude Investigation: Scheduler as an Agent Work OS

## Purpose

This is a handoff brief for investigating the next step after Scheduler's first interactive tmux runner support.

The current codebase is no longer just a queue that calls `claude -p` or `codex exec`. It now has the beginning of a local agent control plane:

- tasks queued and scheduled through JSONL stores
- one worker loop that selects eligible work
- shell runner adapters for Claude, Codex, test, and Claude tmux
- tmux terminal/session registry
- worktree metadata and cleanup hooks
- project summary and admin surfaces
- provider usage gates
- local web UI, optionally exposed through ngrok

The next question is how to turn the tmux path into a generic execution substrate without destabilizing the existing direct runners.

## Current Shipped State

Latest relevant commit:

```text
4bd0454 Add interactive tmux runner support
```

What landed:

- `src/runners/_interactive_tmux.sh`
  - provider-neutral tmux runner backend
  - launches an interactive agent in a tmux session
  - waits for provider readiness
  - pastes the task prompt into the pane
  - waits for a scheduler completion marker
  - supports worktree and in-place task modes
- `src/runners/_claude_tmux.sh`
  - Claude Code adapter for the generic tmux backend
  - unsets API-key-style Claude env vars so the interactive account path is preferred
  - supports resume/fork flags
- `src/runners/claude-*-tmux.sh`
  - explicit additive runner options
  - existing `claude-*` `-p` runners remain unchanged
- `src/terminals/store.js`
  - shared terminal registry persisted in `data/terminals.json`
- `src/worker/poller.js`
  - registers tmux metadata from runner output
  - marks interrupted tmux jobs as orphaned
  - blocks same-repo pending work for one hour after orphaning
  - ignores late runner completions after reset/orphan
- `src/web/server.js`
  - task tail endpoint can stream tmux capture snapshots
  - terminal kill clears the orphan block
- `src/web/public/index.html`
  - exposes Claude tmux runners in the picker
  - shows tmux/orphan state and terminal attach link

Important behavior:

- This is additive. The existing `claude -p` and `codex exec` paths are still available.
- Only Claude tmux is shipped as a runner today.
- The generic backend is intentionally provider-shaped so Codex tmux can be added later.
- Interrupted tmux tasks become failed/orphaned and block the same repo for one hour.
- Killing the attached terminal clears that repo block immediately.

## Product Direction

The right abstraction is probably not "Claude tmux runner." It is:

```text
task -> run -> session -> workspace -> events
```

Definitions:

- Task: user intent, usually stable across retries and branches.
- Run: one concrete execution attempt for a task.
- Session: live or historical execution environment, usually tmux-backed.
- Workspace: repo directory or git worktree used by a run/session.
- Event: append-only lifecycle fact for inspection, recovery, and future automation.

The tmux runner is the first useful proof that Scheduler can own a long-lived execution session rather than just call a headless CLI and wait for stdout.

## Investigation Goals

### 1. Define a Real Session Abstraction

Current `terminals` are close, but too shell-specific.

Investigate a `sessions` model that can cover:

- raw shell sessions
- Claude Code sessions
- future Codex interactive sessions
- manager/supervisor sessions
- orphaned sessions requiring human intervention

Candidate shape:

```js
{
  id,
  type: "shell" | "agent",
  backend: "tmux",
  provider: "claude" | "codex" | null,
  command,
  cwd,
  repoRoot,
  taskId,
  runId,
  workspaceId,
  status: "starting" | "ready" | "running" | "needs_input" | "done" | "orphaned" | "killed",
  ttlSeconds,
  createdAt,
  lastSeenAt,
  killedAt
}
```

Questions:

- Should `data/terminals.json` evolve into `data/sessions.json`, or should sessions be separate and terminals become a view/backend detail?
- What state transitions are required for robust restart recovery?
- What should happen when tmux has a live pane but Scheduler has no persisted session record?
- Should successful in-place agent sessions remain attachable by default?

### 2. Improve tmux Control Without Overbuilding

Current implementation uses:

- `tmux new-session`
- `tmux capture-pane`
- `tmux load-buffer`
- `tmux paste-buffer`
- `tmux send-keys`
- marker scraping from pane output

Investigate better tmux patterns:

- `pipe-pane` for durable logs instead of capture scraping
- `tmux wait-for` for explicit coordination
- hooks such as `pane-exited` or `session-closed`
- `display-message -p` format strings for pane metadata
- session environment variables for Scheduler IDs
- per-session log files under `data/session-logs/`
- whether capture-pane remains enough for V1

Anti-patterns to watch for:

- relying only on regexes against interactive UI chrome
- assuming pane scrollback is durable
- losing the session record if the worker crashes before metadata is persisted
- prompt injection through the completion marker contract
- killing useful user state during cleanup
- making tmux-specific details leak into task and workspace APIs

### 3. Split Tasks from Runs

Today the queue row is both the user's request and the execution attempt.

Investigate the smallest useful `runs` store:

```js
{
  id,
  taskId,
  runner,
  model,
  status,
  startedAt,
  completedAt,
  sessionId,
  workspaceId,
  outputTail,
  finalMessage,
  error
}
```

Questions:

- Can this be added without migrating all historical queue rows immediately?
- Should retries create new runs under the same task?
- How should resume/fork lineage be represented?
- What should the UI show as the primary object: task, run, or session?

### 4. Promote Worktrees into Workspaces

Worktree metadata currently hangs off task records.

Investigate a first-class `workspaces` model:

```js
{
  id,
  kind: "repo" | "worktree",
  repoRoot,
  path,
  branch,
  taskId,
  runId,
  sessionId,
  cleanupPolicy: "delete_on_success" | "keep_on_failure" | "keep_on_pr" | "keep_always",
  status: "active" | "kept" | "removed",
  dirty,
  prUrl,
  createdAt,
  cleanedAt
}
```

Questions:

- Should worktree creation move out of shell runner scripts and into Node orchestration?
- What cleanup policy should be default for failures?
- How should repo locks interact with worktrees?
- Should same-repo blocks ignore isolated durable worktrees?

### 5. Add an Event Log

Before adding complex automation, add durable facts.

Candidate events:

```text
task.created
run.started
session.created
agent.ready
prompt.sent
marker.detected
workspace.created
session.orphaned
repo.blocked
repo.released
terminal.input_sent
run.completed
run.failed
workspace.cleaned
```

Questions:

- JSONL event store or one event array per run/session?
- What events are needed for crash recovery?
- What events are needed for a future Manager Agent?
- Can the UI use events for a real timeline without re-parsing task output?

### 6. MCP Surface for Agent Management

The future server/local bridge is likely an MCP server over Scheduler's control plane.

Investigate a minimal MCP tool set:

- `list_tasks`
- `create_task`
- `get_task`
- `list_runs`
- `get_run`
- `list_sessions`
- `launch_session`
- `capture_session`
- `send_session_input`
- `kill_session`
- `list_workspaces`
- `cleanup_workspace`
- `block_repo`
- `release_repo`

Questions:

- Which tools are safe as read-only first?
- Which write tools need explicit confirmation or policy checks?
- Should the MCP be a separate process or served by the existing Express app?
- How should auth work for local-only vs ngrok-exposed usage?

### 7. Agent Adapter Boundary

Claude tmux is shipped first. Codex tmux should be designed but not rushed.

Investigate the adapter boundary:

```text
agent adapter =
  command construction
  env cleanup
  readiness detection
  prompt delivery strategy
  completion detection
  session/resume/fork behavior
  final output extraction
```

Questions:

- What needs to differ between Claude Code, Codex, and plain shell?
- Can prompt delivery be uniform?
- Can completion detection be uniform, or does each agent need its own protocol?
- How do we detect "needs human input" cleanly?

## Suggested Deliverable

Please produce a short design note with:

1. Recommended next abstraction: `sessions`, `runs`, `workspaces`, or `events` first.
2. Proposed schemas for the first one or two stores.
3. A three-PR implementation sequence.
4. Specific files that should change in each PR.
5. Biggest failure modes and mitigations.
6. Whether current tmux pane scraping should stay for V1 or be replaced with log piping.
7. Recommendation on when to add Codex tmux.
8. Recommendation on what the future MCP should expose first.

Prefer practical sequencing over architecture for its own sake.

## Suggested Three-PR Shape

### PR 1: Sessions Store

Goal: promote terminal registry into a provider-neutral session registry.

Likely files:

- `src/terminals/store.js`
- new `src/sessions/store.js`
- `src/web/server.js`
- `src/worker/poller.js`
- `src/web/public/terminals.html`

Acceptance criteria:

- existing terminal UI still works
- Claude tmux runs register as agent sessions
- killed/orphaned session state is visible
- no behavior change for non-tmux runners

### PR 2: Events and Recovery

Goal: make tmux lifecycle durable and inspectable.

Likely files:

- new `src/events/store.js`
- `src/worker/poller.js`
- `src/runners/_interactive_tmux.sh`
- `src/web/server.js`
- admin/task detail UI

Acceptance criteria:

- run/session lifecycle emits append-only events
- worker restart can explain stale sessions
- UI can show a timeline without parsing stdout

### PR 3: Workspace Registry

Goal: make repo/worktree state manageable outside the runner scripts.

Likely files:

- new `src/workspaces/store.js`
- `src/web/server.js`
- `src/web/public/admin.html`
- `src/runners/_interactive_tmux.sh`
- later, `src/runners/_claude.sh` and `src/runners/_codex.sh`

Acceptance criteria:

- worktrees list as first-class resources
- cleanup policy is explicit
- failed worktrees are preserved by default or clearly policy-controlled
- same-repo blocking logic can reason about active workspaces

## Code Pointers

Start here:

- `README.md`
- `FEATURE_WISHLIST.md`
- `SCHEDULER_V2_5.md`
- `src/worker/poller.js`
- `src/queue/store.js`
- `src/runners/_interactive_tmux.sh`
- `src/runners/_claude_tmux.sh`
- `src/terminals/store.js`
- `src/web/server.js`
- `src/web/public/index.html`
- `src/web/public/terminals.html`
- `src/web/public/admin.html`
- `src/web/public/projects.html`

## Constraints

- Keep existing direct runners working.
- Do not replace `claude -p` or `codex exec` yet.
- Ship Claude tmux first; design for Codex tmux later.
- Keep changes additive and observable.
- Treat local filesystem and credentials as intentionally trusted by this app.
- Preserve user state when unsure.
- Prefer one small durable primitive over a large manager-agent feature jump.

