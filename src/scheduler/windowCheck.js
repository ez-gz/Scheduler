import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = join(__dirname, '../../configs/schedule.json');
export const EXAMPLE_CONFIG_FILE = join(__dirname, '../../configs/schedule.example.json');

export function loadConfig() {
  const path = existsSync(CONFIG_FILE) ? CONFIG_FILE : EXAMPLE_CONFIG_FILE;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Returns { allowed: boolean, reason: string }
export function isInWindow() {
  const config = loadConfig();
  if (!config.windows?.length) return { allowed: true, reason: 'no windows configured' };

  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const timeDecimal = now.getHours() + now.getMinutes() / 60;

  for (const w of config.windows) {
    if (w.days.includes(day) && timeDecimal >= w.startHour && timeDecimal < w.endHour) {
      return { allowed: true, reason: `within window (days:[${w.days}] ${w.startHour}:00-${w.endHour}:00)` };
    }
  }

  return { allowed: false, reason: `outside all configured windows (day=${day}, hour=${timeDecimal.toFixed(1)})` };
}
