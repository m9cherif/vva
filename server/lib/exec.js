import { spawn } from 'node:child_process';

/**
 * Run a child process and capture its output.
 * Never throws: resolves with { code, stdout, stderr, timedOut, error }.
 */
export function run(cmd, args, { timeoutMs = 300_000, cwd, env, onData } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group → clean kill of grandchildren
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false, error: String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const cap = (buf, max) => (buf.length > max ? buf.slice(-Math.floor(max / 2)) : buf);

    // Live streaming of child output (used for download progress); a listener
    // that throws must never break the run.
    const stream = (name) => (d) => {
      const text = d.toString('utf8');
      if (name === 'stdout') stdout = cap(stdout + text, 8_000_000);
      else stderr = cap(stderr + text, 4_000_000);
      try {
        onData?.(text, name);
      } catch {
        /* ignore */
      }
    };
    child.stdout?.on('data', stream('stdout'));
    child.stderr?.on('data', stream('stderr'));

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 0, stdout, stderr, timedOut, ...extra });
    };

    child.on('error', (err) => finish({ code: -1, error: String(err) }));
    child.on('close', (code) => finish({ code: code ?? (timedOut ? 124 : -1) }));
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } else if (child.pid) {
      // Children are spawned detached, so the PID is a process-group leader:
      // killing the group takes ffmpeg/yt-dlp grandchildren down too.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* ignore */
  }
}
