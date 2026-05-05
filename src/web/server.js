import express from 'express';
import { join, dirname } from 'path';
import { readFileSync, writeFileSync, watch, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import * as queue from '../queue/store.js';
import * as scheduled from '../queue/scheduledStore.js';
import { getStatus, pause, resume, poll, forcePull, forceReset } from '../worker/poller.js';
import { getDirs } from './dirs.js';
import { getAllUsage } from '../scheduler/usageRunner.js';
import { refreshUsage } from '../scheduler/usageService.js';
import { loadConfig, saveConfig } from '../scheduler/windowCheck.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const TERMINALS_FILE = join(__dirname, '../../data/terminals.json');
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC));

// ── Helpers ───────────────────────────────────────────────────────────────

function parseTokensFromOutput(output) {
  if (!output) return null;

  // Scan lines from the end — handles both Claude (type:result) and Codex (type:turn.completed)
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line);
      // Claude --output-format json
      if (d?.type === 'result' && d?.usage?.input_tokens != null) {
        return { input: d.usage.input_tokens, output: d.usage.output_tokens ?? 0 };
      }
      // Codex --json
      if (d?.type === 'turn.completed' && d?.usage?.input_tokens != null) {
        return { input: d.usage.input_tokens, output: d.usage.output_tokens ?? 0 };
      }
    } catch {}
  }

  // Legacy: text regex for old tasks
  const tail = output.slice(-3000);
  const inputMatch = tail.match(/[Tt]otal\s+[Ii]nput\s+[Tt]okens[:\s]+([0-9,]+)/)
    ?? tail.match(/[Ii]nput\s+[Tt]okens[:\s]+([0-9,]+)/);
  const outputMatch = tail.match(/[Tt]otal\s+[Oo]utput\s+[Tt]okens[:\s]+([0-9,]+)/)
    ?? tail.match(/[Oo]utput\s+[Tt]okens[:\s]+([0-9,]+)/);
  if (!inputMatch && !outputMatch) return null;
  return {
    input:  inputMatch  ? parseInt(inputMatch[1].replace(/,/g, ''), 10) : 0,
    output: outputMatch ? parseInt(outputMatch[1].replace(/,/g, ''), 10) : 0,
  };
}

function taskTitle(task) {
  const text = String(task?.task ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '(untitled)';
  const firstSentence = text.match(/^(.{1,120}?)([.!?]\s|$)/)?.[1] ?? text.slice(0, 120);
  return firstSentence.length < text.length ? `${firstSentence.trim()}...` : firstSentence.trim();
}

function projectName(dir) {
  const parts = String(dir ?? '').split('/').filter(Boolean);
  return parts.slice(-1)[0] ?? dir ?? '(unknown)';
}

function lastActivity(task) {
  return task.completed ?? task.started ?? task.created ?? null;
}

function readTerminals() {
  if (!existsSync(TERMINALS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TERMINALS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeTerminals(items) {
  writeFileSync(TERMINALS_FILE, JSON.stringify(items, null, 2));
}

function terminalName(id) {
  return `scheduler-term-${id}`;
}

async function tmux(args) {
  return execFileAsync('tmux', args, { maxBuffer: 4 * 1024 * 1024 });
}

async function terminalExists(sessionName) {
  try {
    await tmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function captureTerminal(sessionName) {
  const { stdout } = await tmux(['capture-pane', '-t', sessionName, '-p', '-e', '-S', '-200']);
  return stdout;
}

const TMUX_KEY_ALIASES = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'BSpace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pgup: 'PageUp',
  pageup: 'PageUp',
  pgdown: 'PageDown',
  pagedown: 'PageDown',
  clear: 'C-l',
  'ctrl-c': 'C-c',
  ctrlc: 'C-c',
  'ctrl-d': 'C-d',
  ctrld: 'C-d',
  'ctrl-l': 'C-l',
  ctrll: 'C-l',
  'ctrl-r': 'C-r',
  ctrlr: 'C-r',
};

function normalizeTmuxKey(key) {
  const normalized = String(key ?? '').trim().toLowerCase();
  return TMUX_KEY_ALIASES[normalized] ?? null;
}

function normalizeTaskRequest(body) {
  const { task, dir, worktree, durableWorktree, runner, priority, resumeSessionId, forkSession } = body;
  if (!task?.trim()) throw new Error('task is required');
  if (!dir?.trim()) throw new Error('dir is required');
  const isWorktree = worktree === true || worktree === 'true';
  return {
    task: task.trim(),
    dir: dir.trim(),
    worktree: isWorktree,
    durableWorktree: isWorktree && (durableWorktree === true || durableWorktree === 'true'),
    runner: runner ?? 'claude-sonnet',
    priority: Number(priority ?? 0),
    resumeSessionId: resumeSessionId ?? null,
    forkSession: forkSession === true || forkSession === 'true',
  };
}

function safeWorktrees() {
  return queue.list()
    .filter(t => t.worktreeMeta?.path)
    .map(t => ({
      id: t.id,
      taskId: t.id,
      title: taskTitle(t),
      status: t.status,
      dir: t.dir,
      runner: t.runner,
      durable: t.durableWorktree === true || t.worktreeMeta?.durable === true,
      path: t.worktreeMeta.path,
      repoRoot: t.worktreeMeta.repoRoot,
      branch: t.worktreeMeta.branch,
      kept: t.worktreeMeta.kept === true,
      removed: t.worktreeMeta.removed === true,
      exists: existsSync(t.worktreeMeta.path),
      created: t.created,
      completed: t.completed,
      cleanedAt: t.worktreeCleanedAt ?? null,
    }));
}

// ── Queue API ─────────────────────────────────────────────────────────────

app.post('/api/tasks', (req, res) => {
  try {
    const created = queue.add(normalizeTaskRequest(req.body));
    res.json({ ok: true, task: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/scheduled', (req, res) => {
  try {
    const body = normalizeTaskRequest(req.body);
    const created = scheduled.add({ ...body, scheduledFor: req.body?.scheduledFor });
    res.json({ ok: true, scheduled: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/scheduled', (req, res) => {
  const { status } = req.query;
  res.json(scheduled.list(status ?? null).reverse());
});

app.post('/api/scheduled/:id/queue', (req, res) => {
  try {
    const result = scheduled.promoteNow(req.params.id, queue.add);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/scheduled/:id', (req, res) => {
  try {
    const item = scheduled.cancel(req.params.id);
    res.json({ ok: true, scheduled: item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/queue', (req, res) => {
  const { status } = req.query;
  res.json(queue.list(status ?? null).reverse());
});

app.get('/api/queue/stats', (req, res) => {
  const all = queue.list();
  const scheduledItems = scheduled.list('scheduled');
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    pending: all.filter(t => t.status === 'pending').length,
    scheduled: scheduledItems.length,
    running: all.filter(t => t.status === 'running').length,
    done: all.filter(t => t.status === 'done').length,
    failed: all.filter(t => t.status === 'failed').length,
    cancelled: all.filter(t => t.status === 'cancelled').length,
    total: all.length,
    doneToday: all.filter(t => t.status === 'done' && t.completed?.startsWith(today)).length,
    // Tasks per day for last 7 days (legacy — counts only)
    timeline: (() => {
      const days = {};
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days[d.toISOString().slice(0, 10)] = 0;
      }
      all.filter(t => t.completed).forEach(t => {
        const d = t.completed.slice(0, 10);
        if (d in days) days[d]++;
      });
      return days;
    })(),
    // Full per-day telemetry for last 7 days
    timelineRich: (() => {
      const days = {};
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days[d.toISOString().slice(0, 10)] = { done: 0, failed: 0, cancelled: 0, durationMs: 0, tokensIn: 0, tokensOut: 0 };
      }
      all.filter(t => t.completed).forEach(t => {
        const d = t.completed.slice(0, 10);
        if (!(d in days)) return;
        if (t.status === 'done')      days[d].done++;
        else if (t.status === 'failed')    days[d].failed++;
        else if (t.status === 'cancelled') days[d].cancelled++;
        if (t.started && t.completed) {
          days[d].durationMs += Math.max(0, new Date(t.completed) - new Date(t.started));
        }
        const toks = parseTokensFromOutput(t.output);
        if (toks) { days[d].tokensIn += toks.input; days[d].tokensOut += toks.output; }
      });
      return days;
    })(),
  });
});

app.get('/api/projects/summary', (req, res) => {
  const tasks = [...scheduled.list('scheduled'), ...queue.list()];
  const projects = new Map();

  for (const task of tasks) {
    const dir = task.dir ?? '(unknown)';
    const current = projects.get(dir) ?? {
      dir,
      name: projectName(dir),
      total: 0,
      pending: 0,
      scheduled: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      lastActivity: null,
      runnerMix: {},
      worktrees: 0,
      durableWorktrees: 0,
      recent: [],
    };

    current.total++;
    if (task.status in current) current[task.status]++;
    current.runnerMix[task.runner ?? 'unknown'] = (current.runnerMix[task.runner ?? 'unknown'] ?? 0) + 1;
    if (task.worktree) current.worktrees++;
    if (task.durableWorktree || task.worktreeMeta?.kept) current.durableWorktrees++;

    const activity = lastActivity(task);
    if (activity && (!current.lastActivity || new Date(activity) > new Date(current.lastActivity))) {
      current.lastActivity = activity;
    }

    current.recent.push({
      id: task.id,
      title: taskTitle(task),
      status: task.status,
      runner: task.runner,
      created: task.created,
      completed: task.completed,
    });

    projects.set(dir, current);
  }

  const data = [...projects.values()]
    .map(project => ({
      ...project,
      recent: project.recent
        .sort((a, b) => new Date(b.completed ?? b.created) - new Date(a.completed ?? a.created))
        .slice(0, 5),
    }))
    .sort((a, b) => new Date(b.lastActivity ?? 0) - new Date(a.lastActivity ?? 0));

  res.json({
    totalProjects: data.length,
    totalTasks: tasks.length,
    projects: data,
  });
});

app.get('/api/worktrees', (req, res) => {
  res.json(safeWorktrees().reverse());
});

app.post('/api/worktrees/:id/cleanup', async (req, res) => {
  const task = queue.list().find(t => t.id === req.params.id);
  if (!task?.worktreeMeta?.path) return res.status(404).json({ error: 'worktree not found' });
  const { path, repoRoot } = task.worktreeMeta;
  if (!existsSync(path)) {
    const updatedMeta = { ...task.worktreeMeta, kept: false, removed: true };
    const updated = queue.update(task.id, { worktreeMeta: updatedMeta, worktreeCleanedAt: new Date().toISOString() });
    return res.json({ ok: true, task: updated, alreadyGone: true });
  }

  try {
    await execFileAsync('git', ['-C', repoRoot || task.dir, 'worktree', 'remove', path, '--force'], { maxBuffer: 1024 * 1024 });
    await execFileAsync('git', ['-C', repoRoot || task.dir, 'worktree', 'prune'], { maxBuffer: 1024 * 1024 }).catch(() => {});
    const updatedMeta = { ...task.worktreeMeta, kept: false, removed: true };
    const updated = queue.update(task.id, { worktreeMeta: updatedMeta, worktreeCleanedAt: new Date().toISOString() });
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/terminals', async (req, res) => {
  const terminals = readTerminals();
  const enriched = await Promise.all(terminals.map(async term => ({
    ...term,
    alive: await terminalExists(term.sessionName),
  })));
  res.json(enriched.reverse());
});

app.post('/api/terminals', async (req, res) => {
  const cwd = String(req.body?.cwd ?? homedir()).trim() || homedir();
  const label = String(req.body?.name ?? '').trim();
  if (!existsSync(cwd)) return res.status(400).json({ error: 'cwd does not exist' });

  const id = randomBytes(4).toString('hex');
  const sessionName = terminalName(id);
  try {
    await tmux(['new-session', '-d', '-s', sessionName, '-c', cwd]);
    const term = {
      id,
      sessionName,
      name: label || projectName(cwd),
      cwd,
      backend: 'tmux',
      created: new Date().toISOString(),
      killedAt: null,
    };
    writeTerminals([...readTerminals(), term]);
    res.json({ ok: true, terminal: { ...term, alive: true } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/terminals/:id/snapshot', async (req, res) => {
  const term = readTerminals().find(t => t.id === req.params.id);
  if (!term) return res.status(404).json({ error: 'terminal not found' });
  try {
    const alive = await terminalExists(term.sessionName);
    const output = alive ? await captureTerminal(term.sessionName) : '';
    res.json({ ...term, alive, output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/terminals/:id/stream', async (req, res) => {
  const term = readTerminals().find(t => t.id === req.params.id);
  if (!term) return res.status(404).json({ error: 'terminal not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let last = '';
  let closed = false;
  async function tick() {
    if (closed) return;
    try {
      const alive = await terminalExists(term.sessionName);
      const output = alive ? await captureTerminal(term.sessionName) : '[session ended]';
      if (output !== last) {
        last = output;
        res.write(`data: ${JSON.stringify({ alive, output })}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ alive: false, error: err.message })}\n\n`);
    }
  }

  await tick();
  const interval = setInterval(tick, 1000);
  req.on('close', () => {
    closed = true;
    clearInterval(interval);
  });
});

app.post('/api/terminals/:id/input', async (req, res) => {
  const term = readTerminals().find(t => t.id === req.params.id);
  if (!term) return res.status(404).json({ error: 'terminal not found' });
  const input = String(req.body?.input ?? '');
  const enter = req.body?.enter !== false;
  if (!input && !enter) return res.status(400).json({ error: 'input is required' });

  try {
    if (!(await terminalExists(term.sessionName))) return res.status(410).json({ error: 'terminal is not alive' });
    if (input) await tmux(['send-keys', '-t', term.sessionName, '-l', input]);
    if (enter) await tmux(['send-keys', '-t', term.sessionName, 'Enter']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/terminals/:id/keys', async (req, res) => {
  const term = readTerminals().find(t => t.id === req.params.id);
  if (!term) return res.status(404).json({ error: 'terminal not found' });
  const rawKeys = Array.isArray(req.body?.keys) ? req.body.keys : [req.body?.key];
  const keys = rawKeys.map(normalizeTmuxKey);
  if (!keys.length || keys.some(k => !k)) return res.status(400).json({ error: 'unsupported key' });

  try {
    if (!(await terminalExists(term.sessionName))) return res.status(410).json({ error: 'terminal is not alive' });
    await tmux(['send-keys', '-t', term.sessionName, ...keys]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/terminals/:id/ctrl-c', async (req, res) => {
  const term = readTerminals().find(t => t.id === req.params.id);
  if (!term) return res.status(404).json({ error: 'terminal not found' });
  try {
    if (!(await terminalExists(term.sessionName))) return res.status(410).json({ error: 'terminal is not alive' });
    await tmux(['send-keys', '-t', term.sessionName, 'C-c']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/terminals/:id/kill', async (req, res) => {
  const terminals = readTerminals();
  const idx = terminals.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'terminal not found' });
  try {
    const aliveBefore = await terminalExists(terminals[idx].sessionName);
    if (aliveBefore) {
      await tmux(['kill-session', '-t', terminals[idx].sessionName]);
    }
    const aliveAfter = await terminalExists(terminals[idx].sessionName);
    terminals[idx] = { ...terminals[idx], killedAt: new Date().toISOString() };
    writeTerminals(terminals);
    res.json({ ok: !aliveAfter, terminal: { ...terminals[idx], alive: aliveAfter } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single task (includes full output)
app.get('/api/tasks/:id', (req, res) => {
  const tasks = queue.list();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const updated = queue.update(req.params.id, { status: 'cancelled' });
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id/status', (req, res) => {
  const { status, error: errMsg } = req.body;
  const valid = ['pending', 'done', 'failed', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  try {
    const updates = { status };
    if (status === 'failed') updates.error = errMsg ?? 'manually marked as failed';
    if (status === 'done' || status === 'failed') updates.completed = updates.completed ?? new Date().toISOString();
    if (status === 'pending') { updates.started = null; updates.completed = null; updates.output = null; updates.error = null; }
    const updated = queue.update(req.params.id, updates);
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/requeue', (req, res) => {
  try {
    const updated = queue.requeue(req.params.id);
    res.json({ ok: true, task: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Worker API ────────────────────────────────────────────────────────────

app.get('/api/tasks/:id/tail', (req, res) => {
  const tasks = queue.list();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const encodedDir = task.dir.replace(/\//g, '-');
  const projectDir = join(homedir(), '.claude', 'projects', encodedDir);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let byteOffset = 0;
  let fileWatcher = null;
  let pollInterval = null;
  let closed = false;

  function sendRaw(line) { if (!closed) res.write(`data: ${line}\n\n`); }
  function sendMeta(msg) { if (!closed) res.write(`data: ${JSON.stringify({ _meta: msg })}\n\n`); }

  function drainFile(path) {
    try {
      const size = statSync(path).size;
      if (size <= byteOffset) return;
      const fd = openSync(path, 'r');
      const buf = Buffer.alloc(size - byteOffset);
      readSync(fd, buf, 0, buf.length, byteOffset);
      closeSync(fd);
      byteOffset = size;
      buf.toString('utf8').split('\n').filter(Boolean).forEach(sendRaw);
    } catch {}
  }

  function startFile(path) {
    byteOffset = 0;
    drainFile(path);
    fileWatcher = watch(path, () => { if (!closed) drainFile(path); });
  }

  function findFile() {
    if (task.sessionId) {
      const p = join(projectDir, `${task.sessionId}.jsonl`);
      return existsSync(p) ? p : null;
    }
    try {
      const cutoff = task.started ? new Date(task.started).getTime() - 10000 : Date.now() - 1800000;
      const candidates = readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ path: join(projectDir, f), mtime: statSync(join(projectDir, f)).mtimeMs }))
        .filter(x => x.mtime >= cutoff)
        .sort((a, b) => b.mtime - a.mtime);
      return candidates[0]?.path ?? null;
    } catch { return null; }
  }

  const initial = findFile();
  if (initial) {
    startFile(initial);
  } else if (!existsSync(projectDir)) {
    sendMeta(`project dir not found: ${encodedDir}`);
    res.end();
    return;
  } else {
    sendMeta('waiting for session to start…');
    pollInterval = setInterval(() => {
      if (closed) { clearInterval(pollInterval); return; }
      const p = findFile();
      if (p) { clearInterval(pollInterval); pollInterval = null; startFile(p); }
    }, 2000);
  }

  const keepalive = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    if (pollInterval) clearInterval(pollInterval);
    if (fileWatcher) fileWatcher.close();
  });
});

app.get('/api/status', async (req, res) => res.json(await getStatus()));
app.post('/api/worker/pause', (req, res) => { pause(); res.json({ ok: true, paused: true }); });
app.post('/api/worker/resume', (req, res) => { resume(); res.json({ ok: true, paused: false }); });
app.post('/api/worker/poll', async (req, res) => {
  await poll();
  res.json({ ok: true, status: await getStatus() });
});

app.post('/api/worker/reset', (req, res) => {
  const result = forceReset();
  res.json({ ok: true, ...result });
});

app.post('/api/worker/force-pull', async (req, res) => {
  const result = await forcePull();
  res.json({ ...result, status: await getStatus() });
});

// ── Config API ────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  try {
    res.json(loadConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const config = req.body;
    if (typeof config !== 'object' || !config) return res.status(400).json({ error: 'invalid config' });
    saveConfig(config);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Usage ─────────────────────────────────────────────────────────────────

app.get('/api/usage', (req, res) => {
  getAllUsage()
    .then(data => res.json(data))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.post('/api/usage/:provider/refresh', async (req, res) => {
  try {
    const cwd = req.body?.cwd ?? process.cwd();
    const usage = await refreshUsage(req.params.provider, { cwd });
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dirs ──────────────────────────────────────────────────────────────────

app.get('/api/dirs', (req, res) => res.json(getDirs()));

// ── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3747;
const HOST = process.env.HOST ?? '127.0.0.1';

export function start() {
  app.listen(PORT, HOST, () => {
    console.log(`[web] http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}  (admin: /admin.html)`);
  });
}

if (process.argv[1].endsWith('server.js')) start();
