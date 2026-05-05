import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULED_FILE = join(__dirname, '../../data/scheduled.jsonl');

const QUEUE_FIELDS = [
  'task',
  'dir',
  'worktree',
  'durableWorktree',
  'runner',
  'priority',
  'resumeSessionId',
  'forkSession',
];

function ensureFile() {
  const dir = dirname(SCHEDULED_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(SCHEDULED_FILE)) writeFileSync(SCHEDULED_FILE, '');
}

function readAll() {
  ensureFile();
  const raw = readFileSync(SCHEDULED_FILE, 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function writeAll(items) {
  ensureFile();
  writeFileSync(SCHEDULED_FILE, items.map(item => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''));
}

function assertScheduledFor(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error('scheduledFor must be a valid date');
  return date.toISOString();
}

function toQueuePayload(item) {
  const payload = {};
  for (const field of QUEUE_FIELDS) payload[field] = item[field];
  return {
    ...payload,
    scheduledSourceId: item.id,
    scheduledFor: item.scheduledFor,
  };
}

export function add(data) {
  ensureFile();
  const item = {
    id: randomBytes(4).toString('hex'),
    status: 'scheduled',
    created: new Date().toISOString(),
    scheduledFor: assertScheduledFor(data.scheduledFor),
    queuedAt: null,
    queuedTaskId: null,
    cancelledAt: null,
    error: null,
    runner: 'claude',
    model: 'claude-sonnet-4-6',
    priority: 0,
    worktree: false,
    durableWorktree: false,
    resumeSessionId: null,
    forkSession: false,
    ...data,
  };
  item.scheduledFor = assertScheduledFor(item.scheduledFor);
  appendFileSync(SCHEDULED_FILE, JSON.stringify(item) + '\n');
  return item;
}

export function list(status = null) {
  const items = readAll();
  return status ? items.filter(item => item.status === status) : items;
}

export function update(id, updates) {
  const items = readAll();
  const idx = items.findIndex(item => item.id === id);
  if (idx === -1) throw new Error(`Scheduled task ${id} not found`);
  items[idx] = { ...items[idx], ...updates };
  writeAll(items);
  return items[idx];
}

export function cancel(id) {
  const items = readAll();
  const idx = items.findIndex(item => item.id === id);
  if (idx === -1) throw new Error(`Scheduled task ${id} not found`);
  if (items[idx].status !== 'scheduled') {
    throw new Error(`Scheduled task ${id} is not cancellable (status: ${items[idx].status})`);
  }
  items[idx] = { ...items[idx], status: 'cancelled', cancelledAt: new Date().toISOString() };
  writeAll(items);
  return items[idx];
}

export function due(now = new Date()) {
  const cutoff = now.getTime();
  return readAll()
    .filter(item => item.status === 'scheduled' && new Date(item.scheduledFor).getTime() <= cutoff)
    .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor) || b.priority - a.priority || new Date(a.created) - new Date(b.created));
}

export function promoteDue(addQueueTask, now = new Date()) {
  const cutoff = now.getTime();
  const items = readAll();
  const promoted = [];
  let changed = false;

  const dueItems = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.status === 'scheduled' && new Date(item.scheduledFor).getTime() <= cutoff)
    .sort((a, b) => new Date(a.item.scheduledFor) - new Date(b.item.scheduledFor) || b.item.priority - a.item.priority || new Date(a.item.created) - new Date(b.item.created));

  for (const { item, idx } of dueItems) {
    try {
      const queued = addQueueTask(toQueuePayload(item));
      items[idx] = {
        ...item,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        queuedTaskId: queued.id,
        error: null,
      };
      promoted.push({ scheduled: items[idx], task: queued });
    } catch (err) {
      items[idx] = {
        ...item,
        status: 'failed',
        error: err.message,
      };
    }
    changed = true;
  }

  if (changed) writeAll(items);
  return promoted;
}

export function promoteNow(id, addQueueTask) {
  const items = readAll();
  const idx = items.findIndex(item => item.id === id);
  if (idx === -1) throw new Error(`Scheduled task ${id} not found`);
  if (items[idx].status !== 'scheduled') {
    throw new Error(`Scheduled task ${id} is not queued manually (status: ${items[idx].status})`);
  }
  const queued = addQueueTask(toQueuePayload(items[idx]));
  items[idx] = {
    ...items[idx],
    status: 'queued',
    queuedAt: new Date().toISOString(),
    queuedTaskId: queued.id,
    error: null,
  };
  writeAll(items);
  return { scheduled: items[idx], task: queued };
}
