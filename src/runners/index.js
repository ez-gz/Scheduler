import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Run a task using the shell script for the task's runner.
// Runner scripts receive the full task context via env vars and are responsible
// for all execution logic — worktree setup, agent invocation, cleanup.
// This registry is intentionally thin: it just spawns and streams.
export function run(task) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(__dirname, `${task.runner}.sh`);

    const env = {
      ...process.env,
      TASK_ID: task.id,
      TASK_TEXT: task.task,
      TASK_DIR: task.dir,
      TASK_WORKTREE: String(task.worktree ?? false),
      TASK_DURABLE_WORKTREE: String(task.durableWorktree ?? false),
      TASK_RESUME_SESSION_ID: task.resumeSessionId ?? '',
      TASK_FORK_SESSION: String(task.forkSession ?? false),
    };

    const proc = spawn('bash', [scriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      stdout += chunk;
      process.stdout.write(chunk); // stream to terminal
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    proc.on('error', err => reject(Object.assign(err, { stdout, stderr })));

    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(
          new Error(`${task.runner} runner exited with code ${code}`),
          { stdout, stderr, code }
        ));
      }
    });
  });
}
