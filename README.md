# Scheduler

Scheduler is a local control plane for routing coding tasks to either Claude Code or Codex from one web interface. It is designed for the specific case where your personal computer already has the right projects, credentials, tools, and agent subscriptions, but you want to submit and monitor work from anywhere.

The normal deployment model is intentionally simple: run this repository on your computer, expose only that local web session through an authenticated ngrok tunnel, then send tasks to `claude-code` or `codex-plan`/Codex runners through the Scheduler UI. The agents execute on your machine, with your local shell environment, your local GitHub credentials, and dangerous full access enabled.

## TL;DR
hello, this is Zubin. I use Scheduler to talk to my personal computer's coding agents when I'm away from my computer. It's quite nice to queue up a bunch of work while I'm either at work or out and about and still preserve the respective limits of my coding agents. I find this tool quite useful, it's just a place for me to dump in notes when I want to have a bunch of work assigned to offline agents. I've also built a lot of tools on top of this service such as automated routing for the respective model/best model for a specific task. Try it out, give me feedback, let me know if you like it or don't like it, etc. 

## Requirements

- **macOS** — designed for macOS; Linux may work but is untested
- **Node.js** v18+
- **Claude Code CLI** (`claude`) — install and authenticate it before queuing Claude tasks
- **Codex CLI** (`codex`) — install and authenticate it before queuing Codex tasks
- **GitHub CLI** (`gh`) — authenticate it if you want worktree tasks to push branches and open PRs
- **tmux** — used to launch runner sessions and probe Claude usage (`brew install tmux`)
- **ngrok** — required for the intended remote-access flow (`brew install ngrok`)

## Install and run

```bash
git clone <repo-url> Scheduler
cd Scheduler
npm install
```

Authenticate the tools Scheduler will call on your behalf:

```bash
claude
codex
gh auth login
ngrok config add-authtoken <your-ngrok-token>
```

Then start Scheduler in a local shell and leave that shell running:

```bash
npm start        # web UI + worker at http://localhost:3747
```

Open `http://localhost:3747` locally to submit tasks. Open `http://localhost:3747/admin.html` for worker control, schedule configuration, usage snapshots, and queue telemetry.

By default the web server binds to `127.0.0.1`, so it is reachable only from the local machine until you create a tunnel.

## Remote access with ngrok

Start a second shell from the same repository and run:

```bash
npm run tunnel -- --auth scheduler-user:strong-password
```

Copy the HTTPS ngrok URL into your phone or another computer. ngrok enforces HTTP Basic Auth at its edge, so unauthenticated requests do not reach your laptop. The `--auth` flag is required by `src/tunnel.sh`; the tunnel will refuse to start without it.

Keep both shells alive:

- `npm start` runs the local Scheduler web server and worker.
- `npm run tunnel -- --auth ...` exposes that local server through ngrok.

For a durable setup, run both commands inside `tmux`, a terminal session manager, or your preferred process supervisor.

## Operating model

Scheduler does not create a hosted agent environment. It routes work into agent CLIs that are already installed and authenticated on your personal computer.

- Tasks run in the selected project directory using your local filesystem, shell, environment variables, Git config, SSH keys, and credential helpers.
- Claude runners call `claude` with `--dangerously-skip-permissions`.
- Codex runners call `codex exec` with `--dangerously-bypass-approvals-and-sandbox`.
- Worktree mode creates an isolated `scheduler/<task-id>` branch, runs the task there, then asks the selected agent to commit, push, and open a GitHub PR with your local `gh` credentials.
- In-place mode runs directly in the selected directory and can resume supported agent sessions.

Treat the ngrok URL like access to your development machine. Use a strong Basic Auth password, share it sparingly, and stop the tunnel when you do not need remote submission.

## Known limitations

- `Claude` usage checks are more expensive than `Codex` checks. The scheduler launches a disposable tmux session, runs `claude --model haiku`, opens `/usage`, parses the result, then caches it for a configurable TTL.
- `Codex` usage is read from local session files, so it is cheap and effectively live.
- If Claude usage refresh fails and no cached snapshot is available, Claude-backed tasks will be blocked conservatively until a refresh succeeds.
- Usage snapshots are sanitized before being cached or served by the web UI; they keep the parsed budget windows but omit raw terminal output and absolute local file paths.

## How it works

1. You post a task (description + directory + worktree flag) via the web UI
2. The worker polls the queue every N seconds (default: 60)
3. Before pulling work it checks:
   - Are we inside a configured time window?
   - Is the next task's provider still under its configured weekly budget gate?
4. If clear, it spawns the selected runner with the task context
5. If worktree mode: creates an isolated branch, runs the task there, then runs a second pass to commit/push/open a PR

## Config

Edit `configs/schedule.json`:

```jsonc
{
  "pollIntervalSeconds": 60,

  "windows": [
    { "days": [1,2,3,4,5], "startHour": 9, "endHour": 24 },  // weekdays
    { "days": [6,0],        "startHour": 14, "endHour": 22 }  // weekends
  ],

  "usageLimits": {
    "claude": {
      "enabled": true,
      "weeklyBudgetPct": 80,    // scheduler stops once this % of weekly is consumed
      "cacheTtlSeconds": 900    // how long to cache the Claude /usage scrape
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
  ]                         // directory picker roots; "~" expands to your home dir
}
```

## Structure

```
src/
  index.js            — boot: web server + poll loop
  queue/store.js      — JSONL queue (add/list/update/next/requeue/reapStaleRunning)
  worker/poller.js    — poll loop, pause/resume, status, graceful shutdown
  runners/
    index.js          — spawn runner shell script with env vars
    _claude.sh        — claude -p runner (worktree-aware, session resume/branch)
    _codex.sh         — codex exec runner (worktree-aware, session resume)
  scheduler/
    windowCheck.js    — time window enforcement
    usageRunner.js    — task-aware usage gate wrapper
    usageService.js   — Codex file parser + Claude tmux probe + cache
  web/
    server.js         — Express API + static serving
    dirs.js           — directory picker scanner (reads dirScanRoots from config)
    public/
      index.html      — mobile-friendly task submission + queue view
      admin.html      — worker control, usage, telemetry
      settings.html   — schedule windows, usage gates, remote access
configs/
  schedule.json       — time windows + usage limits
data/
  queue.jsonl         — task queue (gitignored, auto-created on first run)
```

## Runner interface

Runners are shell scripts. They receive:

| Env var | Description |
|---|---|
| `TASK_ID` | Unique task ID |
| `TASK_TEXT` | Full task description passed to the agent |
| `TASK_DIR` | Directory to run in |
| `TASK_WORKTREE` | `"true"` or `"false"` |
| `RUNNER_MODEL` | Model ID (e.g. `claude-sonnet-4-6`) |
| `TASK_RESUME_SESSION_ID` | Session ID to resume (optional) |
| `TASK_FORK_SESSION` | `"true"` to branch instead of resume (Claude only) |

Exit 0 = success. Any other code = failure. Stdout/stderr are captured and stored in the task record.

To add a new runner: drop a `<name>.sh` script in `src/runners/`, then select it in the UI.
