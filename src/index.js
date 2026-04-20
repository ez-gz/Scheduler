import { start } from './web/server.js';
import { poll } from './worker/poller.js';
import { loadConfig } from './scheduler/windowCheck.js';

const config = loadConfig();
const intervalMs = (config.pollIntervalSeconds ?? 60) * 1000;

console.log(`[scheduler] poll interval: ${config.pollIntervalSeconds ?? 60}s`);

// Start web server
start();

// Start poll loop
poll(); // immediate first check
setInterval(poll, intervalMs);
