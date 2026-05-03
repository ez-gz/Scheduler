# Scheduler

Scheduler is a local web control plane for sending coding tasks to agent CLIs that are already installed and authenticated on your computer.

It is built for one practical workflow: keep the real development environment on your personal machine, then submit and monitor Claude Code or Codex work from a browser while you are away. Scheduler queues tasks, checks schedule windows and usage budgets, starts the selected runner, and records the result.

## What This Does

- Runs a local web UI at `http://localhost:3747`.
- Queues agent tasks in `data/queue.jsonl`.
- Runs tasks through shell runners in `src/runners/`.
- Supports Claude Code runners and Codex runners.
- Can run tasks directly in a project directory or in a temporary Git worktree.
- Can expose the local UI through an authenticated ngrok tunnel.
- Provides admin pages for queue status, usage gates, projects, terminals, settings, and worktree cleanup.

## What This Does Not Do

- It does not create a hosted sandbox.
- It does not isolate credentials from the selected agent.
- It does not protect your filesystem from the agent runner.
- It does not replace `claude`, `codex`, `gh`, `git`, `tmux`, or `ngrok`.

Tasks run on your machine, with your local shell environment, credentials, SSH keys, Git config, and CLI auth state.

## Requirements

- macOS. Linux may work, but this project is designed around macOS.
- Node.js 18 or newer.
- `npm`.
- `git`.
- `tmux`.
- Claude Code CLI, available as `claude`.
- Codex CLI, available as `codex`.
- GitHub CLI, available as `gh`, if you want worktree tasks to push branches and open PRs.
- `ngrok`, if you want remote browser access.

Install common tools with Homebrew:

```bash
brew install node tmux gh ngrok
```

Install and authenticate Claude Code and Codex using their normal setup flows before asking Scheduler to use them.

## Clean Onboarding

This section is intentionally detailed. Follow it from top to bottom on a new machine or fresh clone.

### 1. Clone And Install

```bash
git clone <repo-url> Scheduler
cd Scheduler
npm install
```

### 2. Confirm The Required CLIs Exist

```bash
node --version
npm --version
git --version
tmux -V
claude --version
codex --version
gh --version
ngrok version
```

If one command fails, install or fix that tool before continuing.

### 3. Authenticate Local Tools

Run each CLI once in a normal terminal session so it can complete any interactive login or first-run setup:

```bash
claude
codex
gh auth login
ngrok config add-authtoken <your-ngrok-token>
```

Scheduler does not manage these credentials. It only calls these local tools after you have authenticated them.

### 4. Create Local Config

Scheduler reads `configs/schedule.json`. That file is intentionally gitignored because it is machine-specific.

Create it from the example:

```bash
cp configs/schedule.example.json configs/schedule.json
```

Then either edit `configs/schedule.json` directly or use the Settings page after the server starts.

Important config fields:

- `pollIntervalSeconds`: how often the worker checks the queue.
- `windows`: allowed local time windows for running tasks.
- `usageLimits`: budget gates for Claude and Codex.
- `dirScanRoots`: roots shown by the directory picker.
- `features.durableWorktrees`: enables durable worktree behavior in the UI.
- `maxConcurrent`: currently expected to be `1`; the worker runs one task at a time.

### 5. Start Scheduler Locally

```bash
npm start
```

This starts both the web server and the worker poll loop.

Open:

- `http://localhost:3747` for task submission.
- `http://localhost:3747/admin.html` for worker status, queue controls, usage, and telemetry.
- `http://localhost:3747/projects.html` for project summaries.
- `http://localhost:3747/terminals.html` for tmux-backed shell sessions.
- `http://localhost:3747/settings.html` for schedule, usage, and directory settings.

By default the server binds to `127.0.0.1`, so it is local-only.

### 6. Run A No-Cost Smoke Test

Use the `test` runner before spending agent tokens.

From the UI, submit a task with:

- Runner: `test`
- Directory: this Scheduler repo or any harmless test directory
- Worktree: off
- Task text: `smoke test`

The test runner writes to `/tmp/sched-out-<task-id>.txt` and exercises the queue, worker, runner registry, and output capture without calling Claude or Codex.

### 7. Check Worker Health

Open `http://localhost:3747/admin.html` and confirm:

- The worker is not paused.
- The queue can see your test task.
- The task moves from `pending` to `running` to `done`.
- `data/queue.jsonl` has a record for the task.

If the task does not run, check:

- Are you inside an allowed schedule window?
- Is the worker paused?
- Is another task already running?
- Did a usage gate block the selected provider?
- Does the selected runner script exist in `src/runners/`?

### 8. Try A Real Local Task

Submit a small in-place task with `claude-sonnet`, `codex-gpt-5.4-mini`, or another configured runner.

Use a low-risk project directory first. The runner is launched with dangerous permissions enabled, so the selected agent can modify files in that directory.

### 9. Try Worktree Mode

Worktree mode is for tasks that should produce a branch and PR.

When worktree mode is enabled:

1. Scheduler creates a branch named `scheduler/<task-id>`.
2. Scheduler creates a Git worktree next to the repository root.
3. The selected agent runs the implementation task inside that worktree.
4. The selected agent receives a second prompt asking it to commit, push, and open a PR with `gh`.
5. Scheduler removes the worktree unless the task is marked durable.

Before using worktree mode, confirm:

- The target directory is inside a Git repository.
- `gh auth status` succeeds.
- The repository has an `origin` remote.
- Your local Git credentials can push branches.

### 10. Expose It Remotely With ngrok

Keep `npm start` running in one shell. In a second shell, run:

```bash
npm run tunnel -- --auth scheduler-user:strong-password
```

Copy the HTTPS ngrok URL to your phone or another computer. The `--auth` flag is required by `src/tunnel.sh`; the tunnel refuses to start without it.

Keep both processes alive:

- `npm start`: local Scheduler web server and worker.
- `npm run tunnel -- --auth ...`: authenticated public tunnel to the local server.

Treat the ngrok URL like access to your development machine. Use a strong password, share it carefully, and stop the tunnel when you do not need remote access.

## Daily Use

1. Start Scheduler with `npm start`.
2. Open `http://localhost:3747`.
3. Submit a task with a directory, runner, priority, and worktree choice.
4. Monitor progress from the main page or `admin.html`.
5. Requeue failed tasks from the UI when appropriate.
6. Use `terminals.html` when you need a browser-accessible tmux shell.
7. Stop the ngrok tunnel when remote access is no longer needed.

## Runner Choices

Runner scripts live in `src/runners/`. The selected runner name maps directly to `<runner>.sh`.

Current runners:

| Runner | Provider | Model / Behavior |
|---|---|---|
| `claude-haiku` | Claude | `claude-haiku-4-5-20251001` |
| `claude-sonnet` | Claude | `claude-sonnet-4-6` |
| `claude-opus` | Claude | `claude-opus-4-6` |
| `codex-gpt-5.4-mini` | Codex | `gpt-5.4-mini` |
| `codex-gpt-5.4` | Codex | `gpt-5.4` |
| `test` | Local shell | No-token smoke test |

Claude runners call `claude` with `--dangerously-skip-permissions`.

Codex runners call `codex exec` with `--dangerously-bypass-approvals-and-sandbox` and `--skip-git-repo-check`.

## Operating Model

Scheduler has two main pieces:

- Web server: Express app in `src/web/server.js`.
- Worker: poll loop in `src/worker/poller.js`.

`npm start` runs `src/index.js`, which starts both pieces in one Node process.

The worker loop:

1. Reaps stale `running` tasks on startup.
2. Checks whether the worker is paused.
3. Checks whether another task is already running.
4. Checks the configured schedule window.
5. Selects the next pending task by priority, then oldest creation time.
6. Checks provider usage limits.
7. Runs the matching shell runner.
8. Stores task output, final message, session ID, worktree metadata, and status.

## Agent Onboarding Notes

If you are an AI coding agent working in this repository, start here.

### Read These Files First

- `README.md`: project behavior and onboarding.
- `package.json`: available npm scripts.
- `configs/schedule.example.json`: shape of local config.
- `src/index.js`: process entrypoint.
- `src/web/server.js`: HTTP API and static UI serving.
- `src/worker/poller.js`: queue polling and task lifecycle.
- `src/queue/store.js`: JSONL queue storage.
- `src/runners/index.js`: runner dispatch.
- `src/runners/_claude.sh`: shared Claude runner behavior.
- `src/runners/_codex.sh`: shared Codex runner behavior.
- `src/scheduler/windowCheck.js`: schedule config loading and window enforcement.
- `src/scheduler/usageCheck.js`, `src/scheduler/usageRunner.js`, and `src/scheduler/usageService.js`: usage gate logic.

### Do Not Treat Local Data As Source

These files are local runtime state and are gitignored or intentionally machine-specific:

- `configs/schedule.json`
- `data/queue.jsonl`
- `data/terminals.json`
- `data/usage-cache.json`
- `node_modules/`

Do not rewrite, delete, normalize, or commit runtime data unless the user explicitly asks.

### Preserve The Safety Model

The current design intentionally runs agents with broad local permissions. That is a product decision, not an accident.

When changing runner behavior:

- Be explicit about any change to permissions, sandboxing, auth, or shell environment.
- Keep worktree and in-place behavior separate and easy to reason about.
- Do not silently change branch naming, cleanup behavior, or PR creation prompts.
- Do not print secrets, raw auth tokens, or full sensitive terminal output into API responses.

### Keep The Queue Format Compatible

The queue is append/read/rewrite JSONL in `data/queue.jsonl`.

Task records may contain:

- `id`
- `status`
- `created`
- `started`
- `completed`
- `task`
- `dir`
- `runner`
- `priority`
- `worktree`
- `durableWorktree`
- `output`
- `error`
- `sessionId`
- `resumeSessionId`
- `forkSession`
- `worktreeMeta`
- `finalMessage`

If you add fields, keep old records readable.

### Validate With The Test Runner First

For scheduler behavior changes, prefer this order:

1. `npm install`, if dependencies are missing.
2. `npm start`, to catch startup errors.
3. Submit a `test` runner task.
4. Confirm the task completes and records output.
5. Only then test Claude or Codex runners.

This avoids spending agent tokens for basic queue, worker, or API bugs.

### Common Change Areas

- Add or modify API behavior in `src/web/server.js`.
- Add UI behavior in `src/web/public/*.html`.
- Change task lifecycle in `src/worker/poller.js`.
- Change queue persistence in `src/queue/store.js`.
- Add a new provider by creating `src/runners/<name>.sh` and ensuring the UI can select it.
- Change schedule behavior in `src/scheduler/windowCheck.js`.
- Change usage budget behavior in `src/scheduler/usage*.js`.

### Minimal Verification Commands

```bash
npm install
npm start
```

There is currently no dedicated test script in `package.json`. Use the `test` runner smoke test for end-to-end validation.

## Config Reference

Scheduler reads local config from `configs/schedule.json`. If that file does not exist, it falls back to `configs/schedule.example.json`.

Example:

```jsonc
{
  "pollIntervalSeconds": 60,
  "windows": [
    { "days": [1, 2, 3, 4, 5], "startHour": 9, "endHour": 24 },
    { "days": [6, 0], "startHour": 14, "endHour": 22 }
  ],
  "usageLimits": {
    "claude": {
      "enabled": true,
      "weeklyBudgetPct": 80,
      "cacheTtlSeconds": 900
    },
    "codex": {
      "enabled": true,
      "weeklyBudgetPct": 80
    }
  },
  "dirScanRoots": [
    "~",
    "~/Documents",
    "~/Projects"
  ],
  "features": {
    "durableWorktrees": false,
    "codexYuckyBranch": false
  },
  "maxConcurrent": 1
}
```

Notes:

- `days` uses JavaScript day numbers: Sunday is `0`, Monday is `1`, Saturday is `6`.
- `startHour` is inclusive.
- `endHour` is exclusive.
- Hours use local machine time.
- Empty or missing `windows` means tasks are allowed at any time.

## File Structure

```text
src/
  index.js
    Starts the web server and worker poll loop.

  queue/
    store.js
      JSONL queue storage and task state updates.

  worker/
    poller.js
      Poll loop, pause/resume, force-pull, stale task reaping, task execution.

  runners/
    index.js
      Maps a task runner name to a shell script.
    _claude.sh
      Shared Claude runner logic.
    _codex.sh
      Shared Codex runner logic.
    claude-haiku.sh
    claude-sonnet.sh
    claude-opus.sh
    codex-gpt-5.4-mini.sh
    codex-gpt-5.4.sh
    test.sh

  scheduler/
    windowCheck.js
      Loads config and checks schedule windows.
    usageCheck.js
      Decides whether a task can run under provider usage gates.
    usageRunner.js
      Task-aware usage wrapper.
    usageService.js
      Codex usage parsing, Claude usage probing, and usage cache.

  web/
    server.js
      Express API and static file server.
    dirs.js
      Directory picker scanning.
    public/
      index.html
      admin.html
      projects.html
      terminals.html
      settings.html

configs/
  schedule.example.json
    Tracked example config.
  schedule.json
    Local config, gitignored.

data/
  .gitkeep
  queue.jsonl
    Local queue and history, gitignored.
  terminals.json
    Local tmux terminal registry, gitignored.
  usage-cache.json
    Local usage cache, gitignored.
```

## HTTP Surfaces

The UI uses these API groups:

- `POST /api/tasks`: create a task.
- `GET /api/queue`: list tasks.
- `GET /api/queue/stats`: queue telemetry.
- `GET /api/tasks/:id`: fetch one task.
- `DELETE /api/tasks/:id`: mark a task as `cancelled`.
- `PATCH /api/tasks/:id/status`: update task status.
- `POST /api/tasks/:id/requeue`: requeue a failed task.
- `GET /api/tasks/:id/tail`: fetch task output tail.
- `GET /api/status`: worker status.
- `POST /api/worker/pause`: pause worker.
- `POST /api/worker/resume`: resume worker.
- `POST /api/worker/poll`: trigger a poll.
- `POST /api/worker/reset`: clear worker running state.
- `POST /api/worker/force-pull`: run next task while bypassing schedule and usage checks.
- `GET /api/config`: read config.
- `PUT /api/config`: write config.
- `GET /api/usage`: read usage snapshots.
- `POST /api/usage/:provider/refresh`: refresh provider usage.
- `GET /api/dirs`: list directory picker directories.
- `GET /api/projects/summary`: project telemetry.
- `GET /api/worktrees`: worktree telemetry.
- `POST /api/worktrees/:id/cleanup`: remove a completed worktree.
- `GET /api/terminals`: list terminal sessions.
- `POST /api/terminals`: create a tmux-backed terminal.
- `GET /api/terminals/:id/snapshot`: capture terminal output.
- `GET /api/terminals/:id/stream`: stream terminal output.
- `POST /api/terminals/:id/input`: send text input.
- `POST /api/terminals/:id/keys`: send supported special keys.
- `POST /api/terminals/:id/ctrl-c`: send Ctrl-C.
- `POST /api/terminals/:id/kill`: kill a terminal session.

## Runner Interface

Runners are shell scripts. They receive task context through environment variables:

| Env var | Description |
|---|---|
| `TASK_ID` | Unique task ID. |
| `TASK_TEXT` | Full task description passed to the agent. |
| `TASK_DIR` | Directory where the task should run. |
| `TASK_WORKTREE` | `"true"` or `"false"`. |
| `TASK_DURABLE_WORKTREE` | `"true"` or `"false"`. |
| `TASK_RESUME_SESSION_ID` | Session ID to resume, if any. |
| `TASK_FORK_SESSION` | `"true"` to branch instead of resume for supported Claude runs. |

Exit code `0` marks the task as `done`. Any non-zero exit code marks it as `failed`.

Stdout and stderr are captured. The worker stores the last portion of output on the task record.

To add a runner:

1. Create `src/runners/<name>.sh`.
2. Read task context from the environment variables above.
3. Exit non-zero on failure.
4. Select `<name>` from the UI or submit it through `POST /api/tasks`.

## Troubleshooting

### Server Will Not Start

- Run `npm install`.
- Confirm Node.js is version 18 or newer.
- Check whether another process is already using port `3747`.
- Set a different port if needed:

```bash
PORT=3750 npm start
```

### Task Stays Pending

- The worker may be paused.
- The current time may be outside configured `windows`.
- A usage gate may be blocking the selected provider.
- Another task may already be running.
- The selected runner script may not exist.

### Worktree Task Fails

- Confirm the target directory is inside a Git repository.
- Confirm the repo has an `origin` remote.
- Confirm `gh auth status` succeeds.
- Confirm your Git credentials can push to the repo.
- Check whether `../worktree-<task-id>` already exists from an earlier failed run.

### Claude Usage Refresh Fails

Claude usage checks are heavier than Codex usage checks. Scheduler launches a disposable tmux session, runs Claude, opens `/usage`, parses the result, and caches it.

If refresh fails and no cached snapshot is available, Claude-backed tasks are blocked conservatively until refresh succeeds.

### Codex Usage Looks Different From Claude

Codex usage is read from local session files, so it is cheaper and closer to live. Claude usage is probed through a CLI/tmux flow and cached for `cacheTtlSeconds`.

## Security Notes

Scheduler is powerful because it uses your real machine. That is also the main risk.

- Keep the server bound to `127.0.0.1` unless you know why you are changing it.
- Use ngrok Basic Auth every time you expose the UI.
- Use a strong tunnel password.
- Stop the tunnel when not needed.
- Do not share the tunnel URL broadly.
- Assume anyone with access to the Scheduler UI can ask local agents to modify files, run shell commands, use local credentials, push code, and open PRs.

## Useful Commands

```bash
npm start
npm run tunnel -- --auth scheduler-user:strong-password
node src/worker/poller.js
node src/web/server.js
gh auth status
tmux ls
```
