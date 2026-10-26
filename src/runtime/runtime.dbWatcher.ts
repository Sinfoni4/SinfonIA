import { normalizeExportFilter } from '../core/practice/practice.export.js';
import { defaultSchedulerTasks, getAllTenants } from '../core/tenant/tenant.store.js';
import { checkDatabaseConnection } from '../data/db/db.health.js';
import { errorLabel } from '../shared/errors.js';

import { attemptDatabaseRecovery } from './runtime.db.recovery.js';
import { runtimeState } from './runtime.state.js';

import type { PracticeApplicationService } from '../core/practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';

/** Per-tenant last fired period index (in-memory, volatile). */
const schedulerState = {
  monthly: new Map<string, number>(),
  weekly: new Map<string, number>(),
  daily: new Map<string, number>(),
};

let interval: NodeJS.Timeout | null = null;

function resolveDynamicPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const now = new Date();

  function resolve(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value === 'dynamic:currentYear') {
        return now.getFullYear();
      }

      if (value === 'dynamic:currentMonth') {
        return now.getMonth() + 1;
      }

      if (value === 'dynamic:today') {
        return now.toISOString().slice(0, 10);
      }
    }

    if (Array.isArray(value)) {
      return value.map(resolve);
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        result[key] = resolve(nested);
      }
      return result;
    }

    return value;
  }

  const resolved = resolve(payload);
  return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
    ? (resolved as Record<string, unknown>)
    : payload;
}

export function startDbWatcher(
  prisma: PrismaClient,
  practiceService: Pick<PracticeApplicationService, 'exportPractices'>,
) {
  if (interval) return;

  interval = setInterval(() => {
    void (async () => {
      // TEMP DIAGNOSTIC: detect watcher overlap / reconnect races.
      console.log(`🧠 WATCHER TICK ${new Date().toISOString()}`);

      try {
        const now = new Date();

        const tenants = await getAllTenants(prisma);

        for (const tenant of tenants) {
          if (!tenant.scheduler?.enabled) {
            console.log(`⏭️ SCHEDULER SKIPPED — tenant=${tenant.id} (disabled)`);
            continue;
          }

          const frequency = tenant.scheduler?.frequency ?? 'monthly';

          let shouldRun = false;

          if (frequency === 'monthly') {
            const currentMonth = now.getFullYear() * 12 + now.getMonth();
            const last = schedulerState.monthly.get(tenant.id);

            if (last !== currentMonth) {
              schedulerState.monthly.set(tenant.id, currentMonth);
              shouldRun = true;
            }
          }

          if (frequency === 'weekly') {
            const weekOfYear = Math.floor(
              (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) /
                (7 * 24 * 60 * 60 * 1000),
            );
            const currentWeek = now.getFullYear() * 100 + weekOfYear;

            const last = schedulerState.weekly.get(tenant.id);

            if (last !== currentWeek) {
              schedulerState.weekly.set(tenant.id, currentWeek);
              shouldRun = true;
            }
          }

          if (frequency === 'daily') {
            const currentDay =
              now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
            const last = schedulerState.daily.get(tenant.id);

            if (last !== currentDay) {
              schedulerState.daily.set(tenant.id, currentDay);
              shouldRun = true;
            }
          }

          if (!shouldRun) {
            continue;
          }

          console.log(`⏰ SCHEDULE TRIGGER — tenant=${tenant.id} frequency=${frequency}`);

          try {
            console.log(`🏢 SCHEDULER TENANT START — ${tenant.id}`);

            const schedulerUser = await prisma.user.findFirst({
              where: { tenantId: tenant.id, role: 'ADMIN' },
              orderBy: { createdAt: 'asc' },
              select: { id: true },
            });
            if (!schedulerUser) {
              console.warn(`⚠️ SCHEDULER — no ADMIN user for tenant=${tenant.id}`);
              continue;
            }

            const tasks = tenant.tasks ?? defaultSchedulerTasks;

            for (const task of tasks) {
              if (task.type !== 'EXPORT_PRACTICES') {
                console.warn(`⚠️ SCHEDULER — unsupported task tenant=${tenant.id}`);
                continue;
              }

              const resolvedPayload = resolveDynamicPayload(task.payload ?? {});
              const filter = normalizeExportFilter(resolvedPayload);

              console.log(`📦 SCHEDULER TASK — tenant=${tenant.id} type=${task.type}`);

              const result = await practiceService.exportPractices({
                tenantId: tenant.id,
                filter,
              });

              console.log(
                `📦 SCHEDULER EXPORT — tenant=${tenant.id} practices=${result.practices.length}`,
              );
            }
          } catch (err) {
            console.error(`❌ SCHEDULER EXECUTION FAILED — tenant=${tenant.id}`, errorLabel(err));
          }
        }
      } catch (err) {
        console.error('❌ SCHEDULER ERROR', errorLabel(err));
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
