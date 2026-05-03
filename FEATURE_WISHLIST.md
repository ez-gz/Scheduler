# Scheduler Feature Wishlist

## Product Thesis

Scheduler should become the developer-friendly local control plane for getting useful work done on your own machine while you are away from it.

The current app already has the right core: a local Express UI, a durable queue, usage gates, directory selection, runner scripts for Claude/Codex, ngrok-friendly remote access, and basic run inspection. The next version should turn that from "queue that launches agent CLIs" into "one-stop remote work execution platform for my laptop."

The main product primitives should be:

- tasks: user intent, queued or immediate
- runs: concrete execution attempts
- sessions: resumable agent or shell contexts
- workspaces: project directories and Git worktrees
- events: durable timeline records for logs, git state, artifacts, branches, and decisions

`PHASE4.md` already sketches the larger persistent runtime. This wishlist focuses on the features we should actually want and the order they should land.

## Current Repository Read

The repo is small and intentionally direct:

- `src/web/server.js` exposes queue, task, worker, config, usage, and directory APIs.
- `src/queue/store.js` stores task records in `data/queue.jsonl`.
- `src/worker/poller.js` runs one task at a time, updates queue state, and captures final output/session IDs.
- `src/runners/_claude.sh` and `src/runners/_codex.sh` own worktree creation, agent invocation, commit/push/PR prompts, and cleanup.
- `src/web/public/index.html` is the mobile task queue and run detail surface.
- `src/web/public/admin.html` is worker status, telemetry, usage, and manual control.
- `src/web/public/settings.html` already has disabled feature flags for durable worktrees and Codex branching.

The biggest limitation is that task rows are doing too much. Worktrees, runs, sessions, branch lineage, project state, and artifacts all need first-class records if Scheduler is going to become durable and inspectable.

## Top Wishlist Items

## 1. Interactive Terminal Sessions

Goal: from the Scheduler web UI, create a terminal-backed session on the local machine and interact with it from phone or browser.

This is the "spawn tmux panes and give me my shell" feature.

User story:

- I open Scheduler.
- I tap "New Terminal."
- I choose a directory.
- Scheduler creates a durable shell session.
- I can type commands, start `claude`, `codex`, `claude-code`, run tests, inspect files, or leave the shell alive.
- Later, I reconnect to the same session and continue.

V1 scope:

- `POST /api/terminals` creates a session with `{ cwd, name, backend }`.
- `GET /api/terminals` lists sessions.
- `GET /api/terminals/:id/snapshot` captures current scrollback.
- `POST /api/terminals/:id/input` sends keystrokes/text.
- `POST /api/terminals/:id/kill` terminates a session.
- UI page: `/terminal.html` with session list, terminal view, input box, and quick actions.

Backend options:

- preferred: `node-pty` for a proper PTY and terminal UI semantics
- pragmatic fallback: tmux sessions/panes as the durable backend, controlled with `tmux new-session`, `send-keys`, and `capture-pane`

Implementation note:

Make "terminal session" the abstraction, not "tmux pane." tmux can be the backend. That keeps the UI and API clean if we later swap to `node-pty`.

## 2. Durable Worktrees

Goal: worktree tasks can keep their workspace alive after completion so the user can inspect, resume, branch, push, PR, or clean up later.

The config already has `features.durableWorktrees`, and Settings has a disabled toggle. The current runners always remove worktrees:

- `src/runners/_claude.sh`
- `src/runners/_codex.sh`

V1 scope:

- Add `durableWorktree` or `cleanupPolicy` to task records.
- Pass `TASK_DURABLE_WORKTREE=true` or `TASK_CLEANUP_POLICY=keep` into runners.
- If durable, skip `git worktree remove` and persist:
  - worktree path
  - branch name
  - repo root
  - source task ID
  - created/completed timestamps
  - dirty/clean state if available
- Add `/api/worktrees` list endpoint.
- Add `/api/worktrees/:id/cleanup` endpoint.
- Enable the existing Settings flag.
- Show durable worktree path and cleanup action in task detail.

Better v2:

- Move worktree creation and cleanup out of shell scripts and into Node orchestration.
- Add a `workspaces` store so worktrees are not just task metadata.
- Add policies:
  - `delete_on_success`
  - `keep_on_failure`
  - `keep_on_pr`
  - `keep_always`
  - `keep_pinned`

Strong product default:

For developer trust, keep failed worktrees by default. Deleting failed local state is the easiest way to make the product feel scary.

## 3. Project Overview And Work Distribution

Goal: a beautiful, glanceable home/admin view showing what projects Scheduler is working on and what kinds of work are happening.

User story:

- I am working across seven directories.
- I open Scheduler and immediately see the distribution of work by directory/repo.
- I can see recent task themes using the user's initial task message, not LLM categorization.
- I can drill into a project and see its queued, running, failed, and completed work.

V1 scope:

- Add `/api/projects/summary` derived from existing queue records.
- Group tasks by normalized `dir`.
- For each project, compute:
  - total tasks
  - pending/running/done/failed/cancelled counts
  - last activity
  - active runner mix
  - recent task titles from the first line or trimmed first sentence
  - durable worktrees if present
- Add `/projects.html` or an Admin section with:
  - project distribution bars
  - per-project task counts
  - recent task snippets
  - quick filters into queue

V2 graph direction:

- Add run/session lineage:
  - continued from task/session
  - branched from task/session
  - source worktree
  - resulting branch/PR
- Render a simple run graph:
  - linear conversations as connected rows
  - branches as child rows
  - project/repo swimlanes

This does not need a fancy graph library at first. A readable tree with "continued from" and "branched from" links gets most of the value.

## Additional Wishlist Ideas

## 4. Runs View

Separate "task intent" from "execution attempt."

Today one queue row is both the request and the run. A real Runs view should show each execution with:

- prompt
- runner/model
- status
- started/completed time
- terminal/log stream
- final message
- session ID
- branch, commit, PR, and worktree metadata
- token usage
- parent/child run relationship

This is the foundation for branch graphs and durable inspection.

## 5. Mobile Push Notifications And PWA

Scheduler is explicitly useful while away from the computer, so it should behave like a phone app.

Features:

- installable PWA shell
- task completion/failure notifications
- "needs input" notifications for interactive sessions
- deep links to the run detail or terminal session

`PHASE3.md` already calls out Web Push and PWA install.

## 6. Agent Supervisor

Add a Scheduler-focused agent mode whose job is to manage the local agent fleet rather than edit a repo.

Example prompts:

- "Summarize everything that completed today."
- "Find failed tasks from this repo and queue repair attempts."
- "Split these notes into five tasks and schedule them for Codex."
- "Clean merged worktrees older than three days."
- "Show me stale branches created by Scheduler."

Implementation path:

- expose internal Scheduler actions as local HTTP/tool calls
- eventually package them as an MCP server
- let the supervisor create tasks, inspect runs, manage workspaces, and write notes/artifacts

## 7. Task Recipes

Make repeated work easy to launch from a phone.

Examples:

- "fix failing tests"
- "review PR comments"
- "implement Linear issue"
- "run codebase audit"
- "upgrade dependency"
- "create draft PR"

A recipe is a reusable bundle:

- prompt template
- default runner/model
- default directory
- worktree policy
- priority
- post-run behavior

## 8. Resource Lanes And Concurrency

The config has `maxConcurrent`, but the worker currently behaves like a single-run loop.

Useful scheduler lanes:

- one Claude lane
- one Codex lane
- one interactive terminal lane
- per-repo mutex to avoid two agents editing the same repo unless isolated by worktree
- high-priority override lane

The main product value is not raw parallelism. It is avoiding collisions while using separate provider budgets well.

## 9. Dependencies And Follow-Up Automation

Queued work should be able to chain.

Examples:

- run task B only if task A succeeds
- if task A fails, queue a diagnostic prompt
- after PR creation, queue a review pass
- after tests fail, queue a fix attempt in the same worktree
- after merge, clean up the worktree

This turns Scheduler from a queue into a local automation layer.

## 10. Artifacts, Notes, And Capture Inbox

Add a lightweight place to store useful outputs:

- issues
- ideas
- final summaries
- links
- diffs
- PRs
- commands to run later
- copied messages from terminal/chat

Then add actions:

- promote note to task
- promote final message to issue
- promote failed run to repair task
- attach artifact to project/workspace/run

This keeps useful agent output from disappearing into logs.

## 11. Safety And Remote Control

Because Scheduler exposes local machine control, the app needs explicit safety affordances:

- visible tunnel status
- optional stronger auth layer beyond ngrok Basic Auth
- audit log of remote actions
- per-session kill button
- "pause all" panic button
- allowed directory roots
- optional read-only mode for browsing/log inspection
- confirmation gates for destructive terminal actions if needed

The product should still be powerful, but it should make dangerous state obvious.

## Recommended Build Order

## Phase A: Ship Durable Worktrees

This is the smallest feature that directly improves the current workflow.

Tasks:

- add task-level durable flag / cleanup policy
- wire config feature flag into UI
- update runners to skip cleanup when durable
- persist worktree metadata on task completion
- add worktree list and cleanup endpoints
- show worktree state in task detail

## Phase B: Add Project Overview

This gives immediate UI value without a storage migration.

Tasks:

- derive project summary from queue JSONL
- build `/api/projects/summary`
- add project dashboard section/page
- add project filter links into queue
- add recent task snippets per project

## Phase C: Add Terminal Sessions

This unlocks remote local-machine control.

Tasks:

- add terminal session abstraction
- start with tmux backend if fastest
- persist session metadata
- stream/capture output
- send input from UI
- build mobile-friendly terminal page

## Phase D: Split Tasks From Runs

This is the storage foundation for graphs, branching, artifacts, and richer history.

Tasks:

- introduce SQLite or a structured JSON store migration path
- add `runs`, `run_events`, and `workspaces`
- migrate or mirror queue rows
- record lifecycle events
- add Runs view

## Phase E: Add Graph, Supervisor, Recipes, And Automation

Once runs and events exist, the advanced features become straightforward instead of bolted on.

Tasks:

- branch/continuation graph
- task recipes
- follow-up automations
- capture inbox/artifacts
- Scheduler supervisor agent
- push notifications/PWA

## Near-Term Definition Of Done

A practical first release of this wishlist is:

- durable worktree toggle works
- durable worktrees are listed and cleanable
- project overview shows distribution across directories
- terminal sessions can be created, reconnected, sent input, and killed
- every new feature has a visible mobile-first UI path

That would move Scheduler from "offline task queue" to "remote local-machine workbench."
