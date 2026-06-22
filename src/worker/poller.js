import * as queue from '../queue/store.js';
import * as scheduled from '../queue/scheduledStore.js';
import { run } from '../runners/index.js';
import { isInWindow, loadConfig } from '../scheduler/windowCheck.js';
import { findEligibleTask } from '../scheduler/usageCheck.js';
import { upsertTerminal } from '../terminals/store.js';
import { execFileSync } from 'child_process';

// ── Startup: reap any tasks orphaned by a previous crash/kill ─────────────

const reaped = queue.reapStaleRunning('process restarted with task in-flight');
if (reaped > 0) console.log(`[worker] reaped ${reaped} stale running task(s) → failed`);

// ── State ─────────────────────────────────────────────────────────────────

let running = false;
let paused = false;
let currentTask = null;
let lastPollResult = { ok: true, reason: 'not polled yet' };
let pollCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────

function parseSessionId(output) {
  const match = output?.match(/\[SCHEDULER_SESSION_ID\] ([a-f0-9-]{36})/);
  return match?.[1] ?? null;
}

function parseFinalMessage(output) {
  if (!output) return null;
  const lines = output.split('\n');

  // Claude --output-format json: type:"result" with result field
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line);
      if (d?.type === 'result' && typeof d?.result === 'string' && d.result) {
        return d.result;
      }
    } catch {}
  }

  // Codex --json: item.completed with item.type:"agent_message"
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line);
      if (d?.type === 'item.completed' && d?.item?.type === 'agent_message') {
        const text = d.item.text;
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    } catch {}
  }

  const captures = [...output.matchAll(/\[SCHEDULER_TMUX_CAPTURE_BEGIN\]\n([\s\S]*?)\n\[SCHEDULER_TMUX_CAPTURE_END\]/g)];
  const capture = captures.length ? captures[captures.length - 1][1] : '';
  const markerIndex = capture.lastIndexOf('[SCHEDULER_DONE:');
  if (markerIndex > 0) {
    const text = capture
      .slice(0, markerIndex)
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)
      .slice(-80)
      .join('\n')
      .trim();
    if (text) return text;
  }

  return null;
}

function parseWorktreeMeta(output) {
  if (!output) return null;
  const line = output.split('\n').find(l => l.startsWith('[SCHEDULER_WORKTREE] '));
  if (!line) return null;
  try {
    const meta = JSON.parse(line.replace('[SCHEDULER_WORKTREE] ', ''));
    return {
      ...meta,
      kept: output.includes('[SCHEDULER_WORKTREE_KEPT]'),
      removed: output.includes('[SCHEDULER_WORKTREE_REMOVED]'),
    };
  } catch {
    return null;
  }
}

function parseTmuxMetaLine(line) {
  if (!line?.startsWith('[SCHEDULER_TMUX_SESSION] ')) return null;
  try {
    return JSON.parse(line.replace('[SCHEDULER_TMUX_SESSION] ', ''));
  } catch {
    return null;
  }
}

function registerTmuxSession(taskId, meta) {
  if (!meta?.sessionName) return;
  const terminalId = meta.terminalId ?? meta.id ?? `task-${taskId}`;
  const normalized = {
    ...meta,
    id: terminalId,
    terminalId,
  };

  upsertTerminal({
    id: terminalId,
    sessionName: meta.sessionName,
    name: meta.name ?? `task ${taskId}`,
    cwd: meta.cwd,
    backend: 'tmux',
    taskId,
    runner: meta.runner ?? null,
    created: new Date().toISOString(),
    killedAt: null,
  });

  const latest = queue.get(taskId);
  queue.update(taskId, { tmuxMeta: normalized });
  if (latest && latest.status !== 'running') {
    queue.markTmuxOrphaned(taskId, 'tmux session registered after task stopped');
    return;
  }
  if (currentTask?.id === taskId) {
    currentTask = { ...currentTask, tmuxMeta: normalized };
  }
}

function createRunnerOutputHandler(taskId) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const meta = parseTmuxMetaLine(line.trim());
      if (meta) registerTmuxSession(taskId, meta);
    }
  };
}

function parseTmuxMeta(output, task = null) {
  const line = output?.split('\n').find(l => l.startsWith('[SCHEDULER_TMUX_SESSION] '));
  return parseTmuxMetaLine(line?.trim()) ?? task?.tmuxMeta ?? null;
}

function taskRoot(task) {
  const dir = task?.dir ?? task?.tmuxMeta?.cwd;
  if (!dir) return null;
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return dir;
  }
}

function findTmuxBlockForTask(task, blockers = queue.listActiveTmuxOrphans()) {
  const root = taskRoot(task);
  if (!root) return null;
  return blockers.find(blocker => taskRoot(blocker) === root) ?? null;
}

function filterTmuxBlockedTasks(tasks) {
  const blockers = queue.listActiveTmuxOrphans();
  if (!blockers.length) return { runnable: tasks, blocked: [] };
  const blocked = [];
  const runnable = tasks.filter(task => {
    const blocker = findTmuxBlockForTask(task, blockers);
    if (blocker) {
      blocked.push({ task, blocker });
      return false;
    }
    return true;
  });
  return { runnable, blocked };
}

function tmuxBlockReason(blocked) {
  const first = blocked[0];
  if (!first) return 'no runnable tasks';
  const until = first.blocker.tmuxMeta?.blockUntil;
  return `repo blocked by orphaned tmux task ${first.blocker.id}${until ? ` until ${until}` : ''}`;
}

function shouldIgnoreRunnerCompletion(taskId) {
  const latest = queue.get(taskId);
  return !latest || latest.status !== 'running' || latest.tmuxMeta?.lifecycle === 'orphaned';
}

function markCurrentTmuxOrphaned(reason) {
  if (!currentTask?.tmuxMeta?.sessionName) return null;
  try {
    const updated = queue.markTmuxOrphaned(currentTask.id, reason);
    currentTask = { ...currentTask, ...updated };
    return updated;
  } catch (err) {
    console.error(`[worker] failed to mark tmux task ${currentTask.id} orphaned:`, err.message);
    return null;
  }
}

// ── Core poll ─────────────────────────────────────────────────────────────

export async function poll() {
  pollCount++;

  const promoted = scheduled.promoteDue(queue.add);
  if (promoted.length > 0) {
    console.log(`[worker] promoted ${promoted.length} scheduled task(s) into the queue`);
  }

  if (paused) {
    lastPollResult = { ok: false, reason: 'worker paused' };
    return;
  }

  if (running) {
    lastPollResult = { ok: false, reason: 'task already running' };
    return;
  }

  const windowCheck = isInWindow();
  if (!windowCheck.allowed) {
    lastPollResult = { ok: false, reason: windowCheck.reason };
    console.log(`[worker] skip — ${windowCheck.reason}`);
    return;
  }

  const pending = queue.listPending();
  if (!pending.length) {
    lastPollResult = { ok: true, reason: 'queue empty' };
    return;
  }

  const { runnable, blocked } = filterTmuxBlockedTasks(pending);
  if (!runnable.length) {
    const reason = tmuxBlockReason(blocked);
    lastPollResult = { ok: false, reason };
    console.log(`[worker] skip — ${reason}`);
    return;
  }

  const { task, reason: eligibleReason } = await findEligibleTask(runnable);
  if (!task) {
    lastPollResult = { ok: false, reason: eligibleReason };
    console.log(`[worker] skip — ${eligibleReason}`);
    return;
  }

  running = true;
  currentTask = task;
  lastPollResult = { ok: true, reason: `running task ${task.id}` };

  try {
    console.log(`[worker] starting task ${task.id}: ${task.task.slice(0, 80)}...`);
    const startedAt = new Date().toISOString();
    queue.update(task.id, { status: 'running', started: startedAt });
    currentTask = { ...currentTask, started: startedAt };

    const result = await run(task, { onStdout: createRunnerOutputHandler(task.id) });

    if (shouldIgnoreRunnerCompletion(task.id)) {
      console.log(`[worker] ignoring completion for task ${task.id}; task is no longer running`);
      return;
    }

    queue.update(task.id, {
      status: 'done',
      completed: new Date().toISOString(),
      output: result.stdout.slice(-20000),
      sessionId: parseSessionId(result.stdout),
      finalMessage: parseFinalMessage(result.stdout),
      worktreeMeta: parseWorktreeMeta(result.stdout),
      tmuxMeta: parseTmuxMeta(result.stdout, currentTask ?? task),
    });
    console.log(`[worker] task ${task.id} done`);
  } catch (err) {
    const latest = queue.get(task.id);
    if (latest?.status !== 'running') {
      console.log(`[worker] ignoring failure for task ${task.id}; task is no longer running`);
      return;
    }
    const tmuxMeta = parseTmuxMeta((err.stdout ?? '') + (err.stderr ?? ''), currentTask ?? task);
    if (tmuxMeta?.sessionName) {
      queue.update(task.id, {
        output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000),
        worktreeMeta: parseWorktreeMeta((err.stdout ?? '') + (err.stderr ?? '')),
        tmuxMeta,
      });
      queue.markTmuxOrphaned(task.id, err.message);
    } else {
      queue.update(task.id, {
        status: 'failed',
        completed: new Date().toISOString(),
        error: err.message,
        output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000),
        worktreeMeta: parseWorktreeMeta((err.stdout ?? '') + (err.stderr ?? '')),
      });
    }
    console.error(`[worker] task ${task.id} failed:`, err.message);
  } finally {
    running = false;
    currentTask = null;
  }
}

// ── Force pull — bypasses window + usage checks ───────────────────────────

export async function forcePull() {
  if (running) return { ok: false, reason: 'task already running' };

  const promoted = scheduled.promoteDue(queue.add);
  if (promoted.length > 0) {
    console.log(`[worker] force-pull: promoted ${promoted.length} scheduled task(s) into the queue`);
  }

  const pending = queue.listPending();
  const { runnable, blocked } = filterTmuxBlockedTasks(pending);
  if (!runnable.length) return { ok: false, reason: blocked.length ? tmuxBlockReason(blocked) : 'queue empty' };

  const task = runnable[0] ?? null;
  if (!task) return { ok: false, reason: 'queue empty' };

  running = true;
  currentTask = task;
  lastPollResult = { ok: true, reason: `force-pull: running task ${task.id}` };
  console.log(`[worker] force-pull: starting task ${task.id}`);

  try {
    queue.update(task.id, { status: 'running', started: new Date().toISOString() });
    const result = await run(task, { onStdout: createRunnerOutputHandler(task.id) });
    if (shouldIgnoreRunnerCompletion(task.id)) {
      console.log(`[worker] force-pull: ignoring completion for task ${task.id}; task is no longer running`);
      return { ok: false, reason: 'task no longer running', taskId: task.id };
    }
    queue.update(task.id, { status: 'done', completed: new Date().toISOString(), output: result.stdout.slice(-20000), sessionId: parseSessionId(result.stdout), finalMessage: parseFinalMessage(result.stdout), worktreeMeta: parseWorktreeMeta(result.stdout), tmuxMeta: parseTmuxMeta(result.stdout, currentTask ?? task) });
    console.log(`[worker] force-pull: task ${task.id} done`);
    return { ok: true, taskId: task.id };
  } catch (err) {
    const latest = queue.get(task.id);
    if (latest?.status !== 'running') {
      console.log(`[worker] force-pull: ignoring failure for task ${task.id}; task is no longer running`);
      return { ok: false, reason: 'task no longer running', taskId: task.id };
    }
    const tmuxMeta = parseTmuxMeta((err.stdout ?? '') + (err.stderr ?? ''), currentTask ?? task);
    if (tmuxMeta?.sessionName) {
      queue.update(task.id, {
        output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000),
        worktreeMeta: parseWorktreeMeta((err.stdout ?? '') + (err.stderr ?? '')),
        tmuxMeta,
      });
      queue.markTmuxOrphaned(task.id, err.message);
    } else {
      queue.update(task.id, { status: 'failed', completed: new Date().toISOString(), error: err.message, output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000), worktreeMeta: parseWorktreeMeta((err.stdout ?? '') + (err.stderr ?? '')) });
    }
    console.error(`[worker] force-pull: task ${task.id} failed:`, err.message);
    return { ok: false, reason: err.message, taskId: task.id };
  } finally {
    running = false;
    currentTask = null;
  }
}

// ── Control surface (used by web server) ─────────────────────────────────

export function pause() { paused = true; }
export function resume() { paused = false; }

export function forceReset() {
  const wasRunning = running;
  const taskId = currentTask?.id ?? null;
  if (currentTask?.tmuxMeta?.sessionName) {
    markCurrentTmuxOrphaned('worker force-reset with tmux task in-flight');
  } else if (currentTask?.id) {
    try {
      queue.update(currentTask.id, {
        status: 'failed',
        completed: new Date().toISOString(),
        error: 'worker force-reset with task in-flight',
      });
    } catch (err) {
      console.error(`[worker] failed to mark task ${currentTask.id} failed on reset:`, err.message);
    }
  }
  running = false;
  currentTask = null;
  console.log(`[worker] force-reset: wasRunning=${wasRunning} taskId=${taskId}`);
  return { wasRunning, taskId };
}

export async function getStatus() {
  const pending = queue.listPending();
  const { runnable: unblockedPending, blocked } = filterTmuxBlockedTasks(pending);
  const scheduledItems = scheduled.list('scheduled')
    .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor) || b.priority - a.priority || new Date(a.created) - new Date(b.created));
  const { task: eligibleTask, reason: eligibleReason } = unblockedPending.length
    ? await findEligibleTask(unblockedPending)
    : { task: null, reason: blocked.length ? tmuxBlockReason(blocked) : 'queue empty' };
  const usageCheck = eligibleTask
    ? { safe: true, reason: eligibleReason, detail: { provider: null } }
    : { safe: false, reason: eligibleReason, detail: { provider: null } };
  const nextTask = unblockedPending[0] ?? pending[0] ?? null;
  const windowCheck = isInWindow();
  return {
    running,
    paused,
    pollCount,
    lastPollResult,
    windowCheck,
    usageCheck,
    nextTask: nextTask
      ? { id: nextTask.id, runner: nextTask.runner, task: nextTask.task.slice(0, 120), dir: nextTask.dir }
      : null,
    scheduledCount: scheduledItems.length,
    nextScheduled: scheduledItems[0]
      ? { id: scheduledItems[0].id, runner: scheduledItems[0].runner, task: scheduledItems[0].task.slice(0, 120), dir: scheduledItems[0].dir, scheduledFor: scheduledItems[0].scheduledFor }
      : null,
    currentTask: currentTask
      ? { id: currentTask.id, task: currentTask.task.slice(0, 120), dir: currentTask.dir, started: currentTask.started ?? null }
      : null,
    tmuxBlock: blocked[0]
      ? { taskId: blocked[0].blocker.id, blockUntil: blocked[0].blocker.tmuxMeta?.blockUntil ?? null, reason: tmuxBlockReason(blocked) }
      : null,
  };
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[worker] received ${signal}`);
  if (currentTask) {
    console.log(`[worker] marking task ${currentTask.id} as failed (killed)`);
    try {
      if (currentTask.tmuxMeta?.sessionName) {
        queue.markTmuxOrphaned(currentTask.id, `process killed (${signal})`);
      } else {
        queue.update(currentTask.id, {
          status: 'failed',
          completed: new Date().toISOString(),
          error: `process killed (${signal})`,
        });
      }
    } catch (e) {
      console.error('[worker] failed to update task on shutdown:', e.message);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Standalone start (node src/worker/poller.js) ─────────────────────────

if (process.argv[1].endsWith('poller.js')) {
  const config = loadConfig();
  const interval = (config.pollIntervalSeconds ?? 60) * 1000;
  console.log(`[worker] standalone mode — polling every ${config.pollIntervalSeconds ?? 60}s`);
  setInterval(poll, interval);
  poll();
}
