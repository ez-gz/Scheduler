import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, '../../data/queue.jsonl');

function ensureFile() {
  const dir = dirname(QUEUE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(QUEUE_FILE)) writeFileSync(QUEUE_FILE, '');
}

function readAll() {
  ensureFile();
  const raw = readFileSync(QUEUE_FILE, 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function writeAll(tasks) {
  ensureFile();
  writeFileSync(QUEUE_FILE, tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''));
}

export function add(data) {
  ensureFile();
  const task = {
    id: randomBytes(4).toString('hex'),
    status: 'pending',
    created: new Date().toISOString(),
    started: null,
    completed: null,
    output: null,
    error: null,
    runner: 'claude',
    model: 'claude-sonnet-4-6',
    priority: 0,
    worktree: false,
    sessionId: null,
    resumeSessionId: null,
    forkSession: false,
    ...data,
  };
  appendFileSync(QUEUE_FILE, JSON.stringify(task) + '\n');
  return task;
}

export function list(status = null) {
  const tasks = readAll();
  return status ? tasks.filter(t => t.status === status) : tasks;
}

export function update(id, updates) {
  const tasks = readAll();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) throw new Error(`Task ${id} not found`);
  tasks[idx] = { ...tasks[idx], ...updates };
  writeAll(tasks);
  return tasks[idx];
}

// Returns next pending task sorted by priority (desc) then created (asc)
export function next() {
  const pending = readAll()
    .filter(t => t.status === 'pending')
    .sort((a, b) => b.priority - a.priority || new Date(a.created) - new Date(b.created));
  return pending[0] ?? null;
}

export function getStats() {
  const tasks = readAll();
  return {
    pending: tasks.filter(t => t.status === 'pending').length,
    running: tasks.filter(t => t.status === 'running').length,
    done: tasks.filter(t => t.status === 'done').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    total: tasks.length,
  };
}

// Mark any tasks stuck in 'running' as failed — call on startup to reap orphans
// from a previous crashed/killed process.
export function reapStaleRunning(reason = 'process restarted with task in-flight') {
  const tasks = readAll();
  const stale = tasks.filter(t => t.status === 'running');
  if (stale.length === 0) return 0;
  const now = new Date().toISOString();
  const updated = tasks.map(t =>
    t.status === 'running'
      ? { ...t, status: 'failed', completed: now, error: reason }
      : t
  );
  writeAll(updated);
  return stale.length;
}

// Re-enqueue a failed task by resetting it to pending.
export function requeue(id) {
  const tasks = readAll();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) throw new Error(`Task ${id} not found`);
  if (tasks[idx].status !== 'failed') throw new Error(`Task ${id} is not failed (status: ${tasks[idx].status})`);
  tasks[idx] = { ...tasks[idx], status: 'pending', started: null, completed: null, output: null, error: null };
  writeAll(tasks);
  return tasks[idx];
}
