import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../../configs/schedule.json');

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
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
