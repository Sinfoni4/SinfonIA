import { SchedulerService } from '../core/scheduler/scheduler.service.js';
import { checkDatabaseConnection } from '../data/db/db.health.js';
import { errorLabel } from '../shared/errors.js';

import { attemptDatabaseRecovery } from './runtime.db.recovery.js';
import { runtimeState } from './runtime.state.js';

import type { PracticeApplicationService } from '../core/practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';

let interval: NodeJS.Timeout | null = null;

export function stopDbWatcher(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export function startDbWatcher(
  prisma: PrismaClient,
  practiceService: Pick<PracticeApplicationService, 'exportPractices'>,
): void {
  if (interval) return;

  const schedulerService = new SchedulerService(prisma, practiceService);

  interval = setInterval(() => {
    void (async () => {
      // TEMP DIAGNOSTIC: detect watcher overlap / reconnect races.
      console.log(`🧠 WATCHER TICK ${new Date().toISOString()}`);

      // Run durable scheduler only when runtime is operational
      if (runtimeState.getMode() !== 'CIRCUIT_OPEN') {
        try {
          const stats = await schedulerService.tick();
          if (stats.triggeredCount > 0) {
            console.log(`⏰ SCHEDULER TICK — executed ${stats.triggeredCount} jobs`);
          }
        } catch (err) {
          console.error('❌ SCHEDULER ERROR', errorLabel(err));
        }
      }

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
