import { execFile } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { loadConfig } from './windowCheck.js';

const execFileAsync = promisify(execFile);
const HOME = homedir();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const USAGE_CACHE_FILE = join(DATA_DIR, 'usage-cache.json');

const DEFAULT_USAGE_LIMITS = {
  claude: {
    enabled: true,
    weeklyBudgetPct: 80,
    cacheTtlSeconds: 900,
  },
  codex: {
    enabled: true,
    weeklyBudgetPct: 80,
  },
};

const CODEX_USAGE_WINDOW_RULES = {
  shortWindow: {
    label: '5h limit',
    strategy: 'assume_reset_after_expiry',
  },
  longWindow: {
    label: 'Weekly limit',
    strategy: 'assume_reset_after_expiry',
  },
};


export async function getAllUsage(options = {}) {
  const limits = getUsageLimits();
  const codex = decorateUsage('codex', readCodexUsage(), limits.codex);
  const claude = decorateUsage(
    'claude',
    await getClaudeUsage({
      refresh: options.refreshClaude === true,
      cwd: options.cwd,
      allowStale: options.allowStaleClaude !== false,
    }),
    limits.claude
  );

  return {
    codex,
    claude,
    timestamp: new Date().toISOString(),
  };
}

export async function refreshUsage(provider, options = {}) {
  if (provider === 'codex') {
    const limits = getUsageLimits();
    return decorateUsage('codex', readCodexUsage(), limits.codex);
  }

  if (provider === 'claude') {
    const limits = getUsageLimits();
    const refreshed = await refreshClaudeUsage({ cwd: options.cwd });
    return decorateUsage('claude', refreshed, limits.claude);
  }

  throw new Error(`Unknown usage provider: ${provider}`);
}

export async function checkUsageForTask(task) {
  const provider = getUsageProviderForRunner(task?.runner);
  if (!provider) {
    return {
      safe: true,
      reason: `runner ${task?.runner ?? '<none>'} does not require usage gating`,
      detail: { provider: null, runner: task?.runner ?? null },
    };
  }

  const limits = getUsageLimits();
  const usage = provider === 'codex'
    ? decorateUsage('codex', readCodexUsage(), limits.codex)
    : decorateUsage(
        'claude',
        await getClaudeUsage({ refresh: false, cwd: task?.dir, allowStale: true }),
        limits.claude
      );

  return {
    safe: usage.gate.safe,
    reason: usage.gate.reason,
    detail: {
      provider,
      runner: task?.runner ?? null,
      gate: usage.gate,
      usage,
    },
  };
}

export function getUsageProviderForRunner(runner) {
  if (!runner) return null;
  if (runner.startsWith('claude')) return 'claude';
  if (runner.startsWith('codex')) return 'codex';
  return null;
}

export function getUsageLimits() {
  const raw = loadConfig().usageLimits ?? {};
  return {
    claude: {
      enabled: raw.claude?.enabled ?? DEFAULT_USAGE_LIMITS.claude.enabled,
      weeklyBudgetPct: Number(raw.claude?.weeklyBudgetPct ?? DEFAULT_USAGE_LIMITS.claude.weeklyBudgetPct),
      cacheTtlSeconds: Number(raw.claude?.cacheTtlSeconds ?? DEFAULT_USAGE_LIMITS.claude.cacheTtlSeconds),
    },
    codex: {
      enabled: raw.codex?.enabled ?? DEFAULT_USAGE_LIMITS.codex.enabled,
      weeklyBudgetPct: Number(raw.codex?.weeklyBudgetPct ?? DEFAULT_USAGE_LIMITS.codex.weeklyBudgetPct),
    },
  };
}

function decorateUsage(provider, usage, limits) {
  const gate = evaluateUsageAgainstLimits(usage, limits);
  return {
    provider,
    limits,
    gate,
    ...usage,
  };
}

function evaluateUsageAgainstLimits(usage, limits) {
  if (!limits?.enabled) {
    return { safe: true, reason: 'usage gating disabled for provider' };
  }

  if (!usage?.available) {
    return { safe: false, reason: usage?.reason ?? 'usage data unavailable' };
  }

  if (!usage.longWindow) {
    return { safe: false, reason: 'usage snapshot missing weekly window' };
  }

  if (usage.longWindow?.timing?.state === 'reset-assumed') {
    return {
      safe: true,
      reason: `${usage.provider ?? 'provider'} weekly window reset after last snapshot; assuming 0% used in current window`,
    };
  }

  if (usage.longWindow.pctUsed > limits.weeklyBudgetPct) {
    return {
      safe: false,
      reason: `${usage.provider ?? 'provider'} weekly budget reached: ${usage.longWindow.pctUsed}% used of ${limits.weeklyBudgetPct}% allowed`,
    };
  }

  return {
    safe: true,
    reason: `${usage.provider ?? 'provider'} weekly usage OK — ${usage.longWindow.pctUsed}% of ${limits.weeklyBudgetPct}% budget used`,
  };
}

function readCodexUsage() {
  const sessionsDir = join(HOME, '.codex', 'sessions');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    if (!existsSync(sessionsDir)) {
      return unavailable('codex', '~/.codex/sessions not found');
    }

    const files = [];
    walkJsonlFiles(sessionsDir, files);
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (!files.length) return unavailable('codex', 'no Codex session files found');

    for (const filePath of files) {
      const parsed = parseCodexSessionFile(filePath, timeZone);
      if (!parsed) continue;
      const normalized = applyCodexUsageWindowRules(parsed);
      return {
        provider: 'codex',
        available: true,
        source: 'codex-session-file',
        refreshedAt: new Date().toISOString(),
        eventTimestamp: normalized.eventTimestamp,
        planType: normalized.planType,
        credits: normalized.credits,
        shortWindow: normalized.shortWindow,
        longWindow: normalized.longWindow,
        windowPolicy: normalized.windowPolicy,
        rateLimit: {
          shortWindow: normalized.shortWindow,
          longWindow: normalized.longWindow,
        },
      };
    }

    return unavailable('codex', 'no rate limit payload found in Codex session files');
  } catch (error) {
    return unavailable('codex', error.message);
  }
}

function parseCodexSessionFile(filePath, timeZone) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      const rateLimits = event?.payload?.rate_limits;
      if (!rateLimits?.primary || !rateLimits?.secondary) continue;

      return {
        eventTimestamp: event.timestamp ?? null,
        planType: rateLimits.plan_type ?? null,
        credits: rateLimits.credits ?? null,
        shortWindow: normalizeUsedPercentWindow('5h limit', rateLimits.primary, timeZone),
        longWindow: normalizeUsedPercentWindow('Weekly limit', rateLimits.secondary, timeZone),
      };
    } catch {
      // Skip malformed rows.
    }
  }

  return null;
}

function applyCodexUsageWindowRules(parsed, nowMs = Date.now()) {
  const checkedAt = new Date(nowMs).toISOString();
  const shortWindow = applyCodexWindowRule('shortWindow', parsed.shortWindow, nowMs, checkedAt);
  const longWindow = applyCodexWindowRule('longWindow', parsed.longWindow, nowMs, checkedAt);
  const resetAssumed = [shortWindow, longWindow].some(window => window?.timing?.state === 'reset-assumed');

  return {
    ...parsed,
    shortWindow,
    longWindow,
    windowPolicy: {
      checkedAt,
      resetAssumed,
      summary: resetAssumed
        ? 'Last Codex snapshot is outside the current usage window; current window is assumed fresh'
        : 'Codex snapshot falls within the current usage window',
    },
  };
}

function applyCodexWindowRule(key, window, nowMs, checkedAt) {
  if (!window) return null;

  const rule = CODEX_USAGE_WINDOW_RULES[key] ?? {};
  const resetAtMs = Number(window.resetAtEpochSeconds ?? 0) * 1000;
  const canExpire = Number.isFinite(resetAtMs) && resetAtMs > 0;
  const expired = canExpire && nowMs >= resetAtMs;

  if (!expired || rule.strategy !== 'assume_reset_after_expiry') {
    return {
      ...window,
      timing: {
        state: 'current',
        checkedAt,
        observedPctUsed: window.pctUsed,
        observedPctLeft: window.pctLeft,
      },
    };
  }

  return {
    ...window,
    pctUsed: 0,
    pctLeft: 100,
    timing: {
      state: 'reset-assumed',
      checkedAt,
      observedPctUsed: window.pctUsed,
      observedPctLeft: window.pctLeft,
      reason: `${rule.label ?? window.label ?? 'Window'} reset has passed; assuming fresh usage window`,
    },
    observedWindow: {
      pctUsed: window.pctUsed,
      pctLeft: window.pctLeft,
      resetLabel: window.resetLabel ?? null,
    },
    resetLabel: `Reset passed at ${window.resetLabel ?? 'scheduled boundary'}; assuming fresh window`,
  };
}

async function getClaudeUsage(options = {}) {
  const cacheTtlSeconds = getUsageLimits().claude.cacheTtlSeconds;
  const cache = readUsageCache();
  const cached = cache.claude ?? null;

  if (!options.refresh && cached && isCacheFresh(cached, cacheTtlSeconds)) {
    return {
      ...cached.snapshot,
      cached: true,
      cachedAt: cached.cachedAt,
      stale: false,
    };
  }

  const refreshed = await refreshClaudeUsage({ cwd: options.cwd });
  if (refreshed.available) {
    return refreshed;
  }

  if (options.allowStale !== false && cached?.snapshot?.available) {
    return {
      ...cached.snapshot,
      cached: true,
      cachedAt: cached.cachedAt,
      stale: true,
      reason: `${refreshed.reason}; using cached Claude usage from ${cached.cachedAt}`,
    };
  }

  return refreshed;
}

async function refreshClaudeUsage(options = {}) {
  const snapshot = await readClaudeUsageFromFreshSession({
    cwd: options.cwd ?? process.cwd(),
  });

  const normalized = {
    provider: 'claude',
    ...snapshot,
    refreshedAt: new Date().toISOString(),
  };

  if (normalized.available) {
    writeUsageCache({
      ...readUsageCache(),
      claude: {
        cachedAt: normalized.refreshedAt,
        snapshot: normalized,
      },
    });
  }

  return normalized;
}

async function readClaudeUsageFromFreshSession(options = {}) {
  const id = randomUUID().slice(0, 8);
  const socketName = `scheduler-claude-usage-${id}`;
  const sessionName = 'claude-usage';
  const cwd = options.cwd ?? process.cwd();
  const launchCommand = `cd ${shellQuote(cwd)} && env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude --model haiku`;
  const target = `${sessionName}:0.0`;

  try {
    await runTmux(['new-session', '-d', '-s', sessionName, launchCommand], socketName);
    await sleep(6000);

    const ready = await waitForClaudePrompt(socketName, target);
    if (!ready) {
      return unavailable('claude', 'Claude prompt did not reach a stable ready state before /usage');
    }

    await sleep(1500);
    await runTmux(['send-keys', '-t', target, '/usage', 'C-m'], socketName);

    const parsed = await waitForClaudeUsageState(socketName, target);
    await runTmux(['send-keys', '-t', target, 'Escape'], socketName);
    await sleep(250);

    return parsed;
  } catch (error) {
    return unavailable('claude', error.message);
  } finally {
    try {
      await runTmux(['kill-server'], socketName);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function waitForClaudePrompt(socketName, target) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const stdout = await captureTmux(socketName, target);
    const lines = normalizeLines(stdout);
    if (
      lines.some(line => /\? for shortcuts/i.test(line))
      || (lines.some(line => /^❯$|^❯\s*$/.test(line)) && !lines.some(line => /esc to interrupt|thinking with .* effort/i.test(line)))
    ) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function waitForClaudeUsageState(socketName, target) {
  const deadline = Date.now() + 30000;
  let lastParsed = unavailable('claude', 'Timed out waiting for Claude usage dialog');

  while (Date.now() < deadline) {
    const stdout = await captureTmux(socketName, target);
    const parsed = parseClaudeUsageText(stdout);
    lastParsed = parsed;
    if (parsed.state !== 'loading') return parsed;
    await sleep(500);
  }

  return lastParsed;
}

async function captureTmux(socketName, target) {
  const { stdout } = await runTmux(['capture-pane', '-p', '-S', '-260', '-t', target], socketName);
  return stdout;
}

async function runTmux(args, socketName) {
  return execFileAsync('tmux', ['-L', socketName, ...args], { maxBuffer: 1024 * 1024 });
}

function parseClaudeUsageText(rawText) {
  const lines = normalizeLines(rawText);

  if (lines.some(line => /Loading usage data/i.test(line))) {
    return unavailable('claude', 'Claude usage modal is still loading', {
      state: 'loading',
    });
  }

  const windows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] ?? '';
    const reset = lines[index + 2] ?? '';

    if (/^Current session$/i.test(line) && /(\d+)%\s+used/i.test(next) && /^Resets /i.test(reset)) {
      const pctUsed = Number.parseInt(next.match(/(\d+)%\s+used/i)?.[1] ?? '0', 10);
      windows.push({
        label: '5h limit',
        pctUsed,
        pctLeft: clampPercent(100 - pctUsed),
        ...parseClaudeResetLine(reset),
        raw: `${line} | ${next} | ${reset}`,
      });
    }

    if (/^Current week/i.test(line) && /(\d+)%\s+used/i.test(next) && /^Resets /i.test(reset)) {
      const pctUsed = Number.parseInt(next.match(/(\d+)%\s+used/i)?.[1] ?? '0', 10);
      windows.push({
        label: 'Weekly limit',
        pctUsed,
        pctLeft: clampPercent(100 - pctUsed),
        ...parseClaudeResetLine(reset),
        raw: `${line} | ${next} | ${reset}`,
      });
    }
  }

  const shortWindow = windows.find(window => window.label === '5h limit') ?? null;
  const longWindow = windows.find(window => window.label === 'Weekly limit') ?? null;

  if (!shortWindow || !longWindow) {
    return unavailable('claude', 'No Claude usage percentages found in modal', {
      state: 'unparsed',
    });
  }

  return {
    provider: 'claude',
    available: true,
    state: 'parsed',
    source: 'claude-usage-modal',
    shortWindow,
    longWindow,
    rateLimit: {
      shortWindow,
      longWindow,
    },
  };
}

function normalizeUsedPercentWindow(label, window, timeZone) {
  const pctUsed = clampPercent(Number(window?.used_percent ?? 0));
  const date = new Date(Number(window?.resets_at ?? 0) * 1000);
  return {
    label,
    windowMinutes: Number(window?.window_minutes ?? 0),
    pctUsed,
    pctLeft: clampPercent(100 - pctUsed),
    resetAtEpochSeconds: Number(window?.resets_at ?? 0),
    resetAtIso: date.toISOString(),
    resetTime: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date),
    resetDate: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
    }).format(date),
    resetLabel: `${new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)} on ${new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
    }).format(date)}`,
  };
}

function parseClaudeResetLine(line) {
  const text = line.replace(/^Resets\s+/i, '').trim();
  const timeZoneMatch = text.match(/\(([^)]+)\)$/);
  const withoutTimeZone = text.replace(/\s*\([^)]+\)\s*$/, '').trim();
  let resetTime = null;
  let resetDate = null;

  if (/^[0-9]/i.test(withoutTimeZone)) {
    resetTime = withoutTimeZone;
  } else {
    const match = withoutTimeZone.match(/^(.+?)\s+at\s+(.+)$/i);
    if (match) {
      resetDate = match[1];
      resetTime = match[2];
    } else {
      resetDate = withoutTimeZone;
    }
  }

  return {
    resetTime,
    resetDate,
    resetTimeZone: timeZoneMatch?.[1] ?? null,
    resetLabel: text,
  };
}

function walkJsonlFiles(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(path, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
}

function normalizeLines(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function unavailable(provider, reason, extra = {}) {
  return {
    provider,
    available: false,
    refreshedAt: new Date().toISOString(),
    reason,
    ...extra,
  };
}

function readUsageCache() {
  try {
    if (!existsSync(USAGE_CACHE_FILE)) return {};
    const raw = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf8'));
    const clean = sanitizeUsageCache(raw);
    if (JSON.stringify(clean) !== JSON.stringify(raw)) {
      writeFileSync(USAGE_CACHE_FILE, JSON.stringify(clean, null, 2));
    }
    return clean;
  } catch {
    return {};
  }
}

function writeUsageCache(cache) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USAGE_CACHE_FILE, JSON.stringify(sanitizeUsageCache(cache), null, 2));
}

function sanitizeUsageCache(cache) {
  const clean = { ...cache };

  if (clean.claude) {
    clean.claude = {
      ...clean.claude,
      snapshot: sanitizeUsageSnapshot(clean.claude.snapshot),
    };
  }

  if (clean.codex) {
    clean.codex = {
      ...clean.codex,
      snapshot: sanitizeUsageSnapshot(clean.codex.snapshot),
    };
  }

  return clean;
}

function sanitizeUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;

  const clean = { ...snapshot };
  delete clean.rawText;
  delete clean.lines;
  delete clean.sessionFile;

  return clean;
}

function isCacheFresh(entry, ttlSeconds) {
  if (!entry?.cachedAt) return false;
  return Date.now() - new Date(entry.cachedAt).getTime() <= ttlSeconds * 1000;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
