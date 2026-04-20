import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig } from '../scheduler/windowCheck.js';

const HOME = homedir();

const DEFAULT_SCAN_ROOTS = [
  '~',
  '~/Documents',
  '~/Documents/personal',
  '~/Documents/work',
  '~/Projects',
  '~/code',
  '~/dev',
  '~/src',
];

const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'Library', 'Applications']);

function expandRoot(root) {
  if (typeof root !== 'string') return null;
  const trimmed = root.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return HOME;
  if (trimmed.startsWith('~/')) return join(HOME, trimmed.slice(2));
  return trimmed;
}

function getScanRoots() {
  const configuredRoots = loadConfig().dirScanRoots;
  const roots = Array.isArray(configuredRoots) && configuredRoots.length
    ? configuredRoots
    : DEFAULT_SCAN_ROOTS;
  return roots.map(expandRoot).filter(Boolean);
}

function scanDirs(root, depth, maxDepth) {
  if (!existsSync(root)) return [];
  const results = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (SKIP.has(entry.name)) continue;
      const full = join(root, entry.name);
      results.push(full);
      if (depth < maxDepth) results.push(...scanDirs(full, depth + 1, maxDepth));
    }
  } catch { /* skip unreadable */ }
  return results;
}

export function getDirs() {
  const seen = new Set();
  const dirs = [];
  const scanRoots = getScanRoots();

  for (const root of scanRoots) {
    if (existsSync(root) && !seen.has(root)) {
      seen.add(root);
      dirs.push(root);
    }
    for (const d of scanDirs(root, 0, 1)) {
      if (!seen.has(d)) { seen.add(d); dirs.push(d); }
    }
  }

  return dirs.sort();
}
