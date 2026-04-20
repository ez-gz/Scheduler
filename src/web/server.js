import express from 'express';
import { join, dirname } from 'path';
import { readFileSync, writeFileSync, watch, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import * as queue from '../queue/store.js';
import { getStatus, pause, resume, poll, forcePull, forceReset } from '../worker/poller.js';
import { getDirs } from './dirs.js';
import { getAllUsage } from '../scheduler/usageRunner.js';
import { refreshUsage } from '../scheduler/usageService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const CONFIG_FILE = join(__dirname, '../../configs/schedule.json');

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

// ── Queue API ─────────────────────────────────────────────────────────────

app.post('/api/tasks', (req, res) => {
  const { task, dir, worktree, runner, priority, resumeSessionId, forkSession } = req.body;
  if (!task?.trim()) return res.status(400).json({ error: 'task is required' });
  if (!dir?.trim()) return res.status(400).json({ error: 'dir is required' });
  const created = queue.add({
    task: task.trim(),
    dir: dir.trim(),
    worktree: worktree === true || worktree === 'true',
    runner: runner ?? 'claude-sonnet',
    priority: Number(priority ?? 0),
    resumeSessionId: resumeSessionId ?? null,
    forkSession: forkSession === true || forkSession === 'true',
  });
  res.json({ ok: true, task: created });
});

app.get('/api/queue', (req, res) => {
  const { status } = req.query;
  res.json(queue.list(status ?? null).reverse());
});

app.get('/api/queue/stats', (req, res) => {
  const all = queue.list();
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    pending: all.filter(t => t.status === 'pending').length,
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
    res.json(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const config = req.body;
    if (typeof config !== 'object' || !config) return res.status(400).json({ error: 'invalid config' });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
