import { errorLabel } from '../shared/errors.js';

import { runtimeState } from './runtime.state.js';

type Logger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type BackgroundJob = {
  name: string;
  intervalMs: number;
  run: () => Promise<Record<string, number>>;
};

const QUIET_STATS = new Set(['skippedCount', 'alreadySent']);

const timers: NodeJS.Timeout[] = [];
const inFlight = new Set<Promise<void>>();

/**
 * Runs each job on its own interval, independently of the DB watcher. A job never overlaps itself
 * and is skipped while the database circuit is open.
 */
export function startBackgroundWorkers(jobs: BackgroundJob[], log: Logger): void {
  if (timers.length > 0) return;

  for (const job of jobs) {
    let running = false;
    const timer = setInterval(() => {
      if (running || runtimeState.getMode() === 'CIRCUIT_OPEN') return;
      running = true;
      const execution = job
        .run()
        .then((stats) => {
          // Runs that only skipped work (e.g. tasks already done this period) are not logged.
          const didWork = Object.entries(stats).some(([key, n]) => !QUIET_STATS.has(key) && n > 0);
          if (didWork) {
            log.info({ job: job.name, ...stats }, 'Background job completed');
          }
        })
        .catch((err: unknown) => {
          log.error({ job: job.name, error: errorLabel(err) }, 'Background job failed');
        })
        .finally(() => {
          running = false;
          inFlight.delete(execution);
        });
      inFlight.add(execution);
    }, job.intervalMs);
    timer.unref();
    timers.push(timer);
  }
}

/** Stops scheduling new runs and waits for the running ones to finish. */
export async function stopBackgroundWorkers(): Promise<void> {
  for (const timer of timers.splice(0)) {
    clearInterval(timer);
  }
  await Promise.allSettled([...inFlight]);
}
