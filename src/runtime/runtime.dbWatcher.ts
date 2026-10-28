import { checkDatabaseConnection } from '../data/db/db.health.js';
import { errorLabel } from '../shared/errors.js';

import { attemptDatabaseRecovery } from './runtime.db.recovery.js';
import { runtimeState } from './runtime.state.js';

import type { PrismaClient } from '@prisma/client';

let interval: NodeJS.Timeout | null = null;

export function stopDbWatcher(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

// Health only: the scheduler and the outbox dispatcher run in runtime.workers.ts.
export function startDbWatcher(prisma: PrismaClient): void {
  if (interval) return;

  interval = setInterval(() => {
    void (async () => {
      // TEMP DIAGNOSTIC: detect watcher overlap / reconnect races.
      console.log(`🧠 WATCHER TICK ${new Date().toISOString()}`);

      const prevMode = runtimeState.getMode();
      const prevHealth = runtimeState.getHealth();
      const result = await checkDatabaseConnection(prisma);

      if (!result.ok) {
        console.log('⚠️ WATCHER TRIGGER RECONNECT');
        await attemptDatabaseRecovery(prisma);
      }

      const nextFailures = result.ok
        ? Math.max(0, prevHealth.failures - 1)
        : prevHealth.failures + 1;
      const nextSlowQueries =
        result.ok && typeof result.latencyMs === 'number' && result.latencyMs > 500
          ? prevHealth.slowQueries + 1
          : prevHealth.slowQueries;

      runtimeState.updateHealthScore({
        latencyMs: result.latencyMs,
        failures: nextFailures,
        slowQueries: nextSlowQueries,
        lastCheck: Date.now(),
      });

      const score = runtimeState.getHealth().score;
      const nextMode = score >= 70 ? 'HEALTHY' : score >= 30 ? 'DEGRADED' : 'CIRCUIT_OPEN';
      runtimeState.setMode(nextMode);

      if (prevMode !== nextMode && prevMode !== 'HEALTHY' && nextMode === 'HEALTHY') {
        console.log('💚 Database reconnected — switching to HEALTHY mode');
      }
    })().catch((error: unknown) => {
      console.error('❌ WATCHER ERROR', errorLabel(error));
    });
  }, 10000);
}
