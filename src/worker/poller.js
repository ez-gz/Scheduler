import * as queue from '../queue/store.js';
import { run } from '../runners/index.js';
import { isInWindow, loadConfig } from '../scheduler/windowCheck.js';
import { isUsageSafe } from '../scheduler/usageCheck.js';

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

// ── Core poll ─────────────────────────────────────────────────────────────

export async function poll() {
  pollCount++;

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

  const task = queue.next();
  if (!task) {
    lastPollResult = { ok: true, reason: 'queue empty' };
    return;
  }

  const usageCheck = await isUsageSafe(task);
  if (!usageCheck.safe) {
    lastPollResult = { ok: false, reason: usageCheck.reason };
    console.log(`[worker] skip — ${usageCheck.reason}`);
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

    const result = await run(task);

    queue.update(task.id, {
      status: 'done',
      completed: new Date().toISOString(),
      output: result.stdout.slice(-20000),
      sessionId: parseSessionId(result.stdout),
      finalMessage: parseFinalMessage(result.stdout),
      worktreeMeta: parseWorktreeMeta(result.stdout),
    });
    console.log(`[worker] task ${task.id} done`);
  } catch (err) {
    queue.update(task.id, {
      status: 'failed',
      completed: new Date().toISOString(),
      error: err.message,
      output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000),
      worktreeMeta: parseWorktreeMeta((err.stdout ?? '') + (err.stderr ?? '')),
    });
    console.error(`[worker] task ${task.id} failed:`, err.message);
  } finally {
    running = false;
    currentTask = null;
  }
}

// ── Force pull — bypasses window + usage checks ───────────────────────────

export async function forcePull() {
  if (running) return { ok: false, reason: 'task already running' };

  const task = queue.next();
  if (!task) return { ok: false, reason: 'queue empty' };

  running = true;
  currentTask = task;
  lastPollResult = { ok: true, reason: `force-pull: running task ${task.id}` };
  console.log(`[worker] force-pull: starting task ${task.id}`);

  try {
    queue.update(task.id, { status: 'running', started: new Date().toISOString() });
    const result = await run(task);
    queue.update(task.id, { status: 'done', completed: new Date().toISOString(), output: result.stdout.slice(-20000), sessionId: parseSessionId(result.stdout), finalMessage: parseFinalMessage(result.stdout), worktreeMeta: parseWorktreeMeta(result.stdout) });
    console.log(`[worker] force-pull: task ${task.id} done`);
    return { ok: true, taskId: task.id };
  } catch (err) {
    queue.update(task.id, { status: 'failed', completed: new Date().toISOString(), error: err.message, output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000), worktreeMeta: parseWorktreeMeta((err.stdout ?? '') + (err.stderr ?? '')) });
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
  running = false;
  currentTask = null;
  console.log(`[worker] force-reset: wasRunning=${wasRunning} taskId=${taskId}`);
  return { wasRunning, taskId };
}

export async function getStatus() {
  const nextTask = queue.next();
  const usageCheck = nextTask
    ? await isUsageSafe(nextTask)
    : { safe: true, reason: 'queue empty', detail: { provider: null } };
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
    currentTask: currentTask
      ? { id: currentTask.id, task: currentTask.task.slice(0, 120), dir: currentTask.dir, started: currentTask.started ?? null }
      : null,
  };
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[worker] received ${signal}`);
  if (currentTask) {
    console.log(`[worker] marking task ${currentTask.id} as failed (killed)`);
    try {
      queue.update(currentTask.id, {
        status: 'failed',
        completed: new Date().toISOString(),
        error: `process killed (${signal})`,
      });
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
