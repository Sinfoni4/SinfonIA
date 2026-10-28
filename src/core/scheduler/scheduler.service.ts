import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { SchedulerRepository } from '../../data/repositories/scheduler.repository.js';
import { errorLabel } from '../../shared/errors.js';
import { normalizeExportFilter } from '../practice/practice.export.js';
import { defaultSchedulerTasks, getAllTenants } from '../tenant/tenant.store.js';

import type { PracticeApplicationService } from '../practice/practice.application.service.js';
import type { SchedulerFrequency, SchedulerTask, Tenant } from '../tenant/tenant.store.js';
import type { PrismaClient } from '@prisma/client';

export function resolveDynamicPayload(
  payload: Record<string, unknown>,
  now = new Date(),
): Record<string, unknown> {
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

export function computePeriodKey(frequency: SchedulerFrequency, now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  switch (frequency) {
    case 'daily':
      return `${year}-${month}-${day}`;
    case 'weekly': {
      const startOfYear = new Date(year, 0, 1);
      const weekNumber = Math.ceil(
        ((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
      );
      return `${year}-W${String(weekNumber).padStart(2, '0')}`;
    }
    case 'monthly':
      return `${year}-${month}`;
  }
}

export function computeNextRun(frequency: SchedulerFrequency, now: Date): Date {
  const next = new Date(now);
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      return next;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      next.setHours(0, 0, 0, 0);
      return next;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(0, 0, 0, 0);
      return next;
  }
}

export function computeIdempotencyKey(
  tenantId: string,
  taskType: string,
  frequency: SchedulerFrequency,
  now: Date,
): string {
  const period = computePeriodKey(frequency, now);
  return `${tenantId}:${taskType}:${frequency}:${period}`;
}

export class SchedulerService {
  private readonly schedulerRepo: SchedulerRepository;
  private readonly outboxRepo: OutboxRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly practiceService: Pick<PracticeApplicationService, 'exportPractices'>,
  ) {
    this.schedulerRepo = new SchedulerRepository(prisma);
    this.outboxRepo = new OutboxRepository(prisma);
  }

  /**
   * Main durable scheduler tick.
   * Scans all tenants (or a specific tenant if provided) and executes due jobs idempotently under PostgreSQL advisory locks.
   */
  async tick(
    now = new Date(),
    tenantId?: string,
  ): Promise<{ triggeredCount: number; skippedCount: number }> {
    let triggeredCount = 0;
    let skippedCount = 0;

    let tenants = await getAllTenants(this.prisma);
    if (tenantId) {
      tenants = tenants.filter((t) => t.id === tenantId);
    }

    for (const tenant of tenants) {
      if (!tenant.scheduler?.enabled) {
        continue;
      }

      const tasks = tenant.tasks ?? defaultSchedulerTasks;
      for (const task of tasks) {
        const executed = await this.executeTenantTask(tenant, task, now);
        if (executed) {
          triggeredCount++;
        } else {
          skippedCount++;
        }
      }
    }

    return { triggeredCount, skippedCount };
  }

  private async executeTenantTask(
    tenant: Tenant,
    task: SchedulerTask,
    now: Date,
  ): Promise<boolean> {
    const frequency = tenant.scheduler.frequency ?? 'monthly';
    const idempotencyKey = computeIdempotencyKey(tenant.id, task.type, frequency, now);

    // 1. Fast check: has this already succeeded in PostgreSQL for this period?
    const alreadyCompleted = await this.schedulerRepo.hasSuccessfulRun(idempotencyKey);
    if (alreadyCompleted) {
      return false;
    }

    // 2. Ensure durable job record exists in scheduler_job
    const job = await this.schedulerRepo.findOrCreateJob({
      tenantId: tenant.id,
      taskType: task.type,
      frequency,
      payload: task.payload,
    });

    // 3. Acquire PostgreSQL session advisory lock to prevent duplicate runs across workers
    const lockKey = `scheduler:${tenant.id}:${task.type}`;
    const { executed, result } = await this.schedulerRepo.withAdvisoryLock(lockKey, async () => {
      // Double check idempotency inside lock
      if (await this.schedulerRepo.hasSuccessfulRun(idempotencyKey)) {
        return false;
      }

      // Scheduled tasks run only for tenants with at least one ADMIN user
      const adminUser = await this.prisma.user.findFirst({
        where: { tenantId: tenant.id, role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      if (!adminUser) {
        console.warn(`⚠️ SCHEDULER — no ADMIN user found for tenant=${tenant.id}`);
        return false;
      }

      // Create RUNNING run record (unique idempotencyKey ensures DB constraint safety)
      const run = await this.schedulerRepo.createRun({
        tenantId: tenant.id,
        jobId: job.id,
        idempotencyKey,
      });

      try {
        let runResult: Record<string, unknown> = {};

        if (task.type === 'EXPORT_PRACTICES') {
          const resolvedPayload = resolveDynamicPayload(task.payload ?? {}, now);
          const filter = normalizeExportFilter(resolvedPayload);

          // Tenant-wide export: no userId, so practices of every tenant user are included.
          const exported = await this.practiceService.exportPractices({
            tenantId: tenant.id,
            filter,
          });

          runResult = {
            title: exported.title,
            practiceCount: exported.practices.length,
            filter: exported.filter,
          };

          // Write to Outbox table for durable delivery
          await this.outboxRepo.createMessage({
            tenantId: tenant.id,
            eventType: 'PRACTICE_EXPORT_GENERATED',
            payload: {
              title: exported.title,
              csv: exported.csv,
              practiceCount: exported.practices.length,
              filter: exported.filter,
              generatedAt: now.toISOString(),
            },
          });
        }

        // Mark run as COMPLETED
        await this.schedulerRepo.completeRun(run.id, runResult);

        // Update job timestamps
        const nextRunAt = computeNextRun(frequency, now);
        await this.schedulerRepo.updateJobRunTimestamps(job.id, now, nextRunAt);

        return true;
      } catch (err: unknown) {
        await this.schedulerRepo.failRun(run.id, errorLabel(err));
        throw err;
      }
    });

    return Boolean(executed && result);
  }
}
