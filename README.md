# Scheduler

Async task queue that runs `claude-code` sessions on your behalf — only within your configured time windows and usage limits. Post tasks from your phone via LAN (or ngrok), come back later to review the results.

## Requirements

- **macOS** — designed for macOS; Linux may work but is untested
- **Node.js** v18+
- **Claude Code CLI** (`claude`) — must be installed and authenticated
- **tmux** — used to launch runner sessions and probe Claude usage (`brew install tmux`)
- **ngrok** _(optional)_ — only needed for remote access via `npm run tunnel` (`brew install ngrok`)

## Quick start

```bash
npm install
npm start        # web UI + worker (http://localhost:3747)
```

Open `http://localhost:3747` to submit tasks. Open `/admin.html` for worker control and schedule config.
The web server binds to `127.0.0.1` by default, so it is only reachable from the local machine unless you explicitly tunnel it.

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

## Remote access (ngrok)

```bash
npm run tunnel -- --auth user:pass
```

The `--auth` flag is required — the tunnel won't start without it. ngrok enforces HTTP Basic Auth at its edge so no unauthenticated traffic ever reaches your machine. Your browser or phone will prompt for the credentials when you open the ngrok URL.

```bash
brew install ngrok   # if you don't have it
```
