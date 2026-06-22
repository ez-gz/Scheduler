import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TERMINALS_FILE = join(__dirname, '../../data/terminals.json');

function ensureFile() {
  const dir = dirname(TERMINALS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(TERMINALS_FILE)) writeFileSync(TERMINALS_FILE, '[]\n');
}

export function readTerminals() {
  ensureFile();
  try {
    return JSON.parse(readFileSync(TERMINALS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function writeTerminals(items) {
  ensureFile();
  writeFileSync(TERMINALS_FILE, JSON.stringify(items, null, 2));
}

export function terminalName(id) {
  return `scheduler-term-${id}`;
}

export function upsertTerminal(term) {
  const terminals = readTerminals();
  const idx = terminals.findIndex(item => item.id === term.id || item.sessionName === term.sessionName);
  const normalized = {
    backend: 'tmux',
    created: new Date().toISOString(),
    killedAt: null,
    ...term,
  };
  if (idx === -1) {
    terminals.push(normalized);
  } else {
    terminals[idx] = { ...terminals[idx], ...normalized };
  }
  writeTerminals(terminals);
  return normalized;
}
