import * as fs from 'fs';
import * as path from 'path';

import { log } from '../shared/log.js';

/**
 * Development guard against two copies of SinfonIA started from the same folder (e.g. a hot
 * reload racing a previous process). A PID file in .runtime/ blocks the second start.
 *
 * In production there is no PID file: instances coordinate through PostgreSQL (advisory locks
 * for the scheduler, SKIP LOCKED claims for the outbox), so several replicas can run. The one
 * exception is Telegram polling, which must run in a single instance.
 */

function getPidFilePath() {
  // A second, separate instance (e.g. the dashboard demo on the test database) has its own lock.
  const instance = process.env.SINFONIA_INSTANCE?.replace(/[^a-z0-9-]/gi, '');
  return path.join(process.cwd(), '.runtime', instance ? `dev-${instance}.pid` : 'dev.pid');
}

const isProduction = () => process.env.NODE_ENV === 'production';

export function acquireProcessLock(): void {
  if (isProduction()) {
    log.info('Process lock disabled in production: instances coordinate through the database');
    return;
  }
  try {
    const pidFile = getPidFilePath();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });

    if (fs.existsSync(pidFile)) {
      const existingPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isFinite(existingPid) && existingPid > 0 && existingPid !== process.pid) {
        try {
          process.kill(existingPid, 0);
          log.warn({ pid: existingPid }, 'Another SinfonIA process is running here: not starting');
          process.exit(0);
        } catch {
          // Not running: stale PID file, taken over below.
        }
      }
    }

    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    log.debug({ pid: process.pid }, 'Process lock acquired');
  } catch (err: unknown) {
    // A development convenience: never prevents the start.
    log.debug({ error: err instanceof Error ? err.name : 'Error' }, 'Process lock unavailable');
  }
}

export function releaseProcessLock(): void {
  if (isProduction()) return;
  try {
    const pidFile = getPidFilePath();
    // Only our own lock: never remove the file of another running process.
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Never throw during shutdown.
  }
}
