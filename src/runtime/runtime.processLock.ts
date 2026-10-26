import * as fs from 'fs';
import * as path from 'path';

function getProjectRoot() {
  // The dev server (nodemon) is expected to run from project root.
  return process.cwd();
}

function getPidFilePath() {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, '.runtime', 'dev.pid');
}

export function acquireProcessLock(): void {
  try {
    const pidFile = getPidFilePath();
    const dir = path.dirname(pidFile);

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }

    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, 'utf8');
      const existingPid = Number(raw.trim());

      if (Number.isFinite(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          console.log(
            `🧱 Existing SinfonIA process detected (PID ${existingPid}) — aborting start`,
          );
          process.exit(0);
        } catch {
          // process not running; stale pid file
          try {
            fs.unlinkSync(pidFile);
          } catch {
            // ignore
          }
        }
      } else {
        try {
          fs.unlinkSync(pidFile);
        } catch {
          // ignore
        }
      }
    }

    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    console.log(`🔒 Process lock acquired (PID ${process.pid})`);
  } catch {
    // Never throw: lock is a dev-only safety net.
  }
}

export function releaseProcessLock(): void {
  try {
    const pidFile = getPidFilePath();
    if (fs.existsSync(pidFile)) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }
    console.log('🔓 Process lock released');
  } catch {
    // Never throw
  }
}
