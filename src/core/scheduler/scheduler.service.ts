import { SchedulerRepository } from '../../data/repositories/scheduler.repository.js';
import { errorLabel } from '../../shared/errors.js';
import { log } from '../../shared/log.js';
import { ComplianceService } from '../compliance/compliance.service.js';
import { defaultSchedulerTasks, getAllTenants } from '../tenant/tenant.store.js';

import { ComplianceDeadlinesTask, ExportPracticesTask } from './scheduler.tasks.js';

import type { SchedulerTaskHandler } from './scheduler.tasks.js';
import type { PracticeApplicationService } from '../practice/practice.application.service.js';
import type {
  SchedulerFrequency,
  SchedulerTask,
  SchedulerTaskType,
  Tenant,
} from '../tenant/tenant.store.js';
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

/**
 * Tasks every tenant gets, with their own frequency, whatever its scheduler settings: compliance
 * reminders must not depend on the tenant having enabled scheduled exports.
 */
const SYSTEM_TASKS: Array<{ task: SchedulerTask; frequency: SchedulerFrequency }> = [
  { task: { type: 'CHECK_COMPLIANCE_DEADLINES' }, frequency: 'daily' },
];
const SYSTEM_TASK_TYPES = new Set<SchedulerTaskType>(SYSTEM_TASKS.map((s) => s.task.type));

export class SchedulerService {
  private readonly schedulerRepo: SchedulerRepository;
  private readonly handlers: Map<SchedulerTaskType, SchedulerTaskHandler>;

  constructor(
    private readonly prisma: PrismaClient,
    practiceService: Pick<PracticeApplicationService, 'exportPractices'>,
    options: {
      /** Replaces the default task handlers (export and compliance check). */
      handlers?: SchedulerTaskHandler[];
      complianceService?: Pick<ComplianceService, 'sendDueReminders'>;
    } = {},
  ) {
    this.schedulerRepo = new SchedulerRepository(prisma);
    const handlers = options.handlers ?? [
      new ExportPracticesTask(prisma, practiceService),
      new ComplianceDeadlinesTask(options.complianceService ?? new ComplianceService(prisma)),
    ];
    this.handlers = new Map(handlers.map((h) => [h.type, h]));
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

    // Suspended or deactivated organizations get no scheduled task (MF5).
    const active = new Set(
      (
        await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
      ).map((t) => t.id),
    );
    let tenants = (await getAllTenants(this.prisma)).filter((t) => active.has(t.id));
    if (tenantId) {
      tenants = tenants.filter((t) => t.id === tenantId);
    }

    for (const tenant of tenants) {
      const configured = tenant.scheduler?.enabled
        ? (tenant.tasks ?? defaultSchedulerTasks)
            .filter((task) => !SYSTEM_TASK_TYPES.has(task.type))
            .map((task) => ({ task, frequency: tenant.scheduler.frequency ?? 'monthly' }))
        : [];

      for (const { task, frequency } of [...configured, ...SYSTEM_TASKS]) {
        const executed = await this.executeTenantTask(tenant, task, frequency, now);
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
    frequency: SchedulerFrequency,
    now: Date,
  ): Promise<boolean> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      log.warn({ task: task.type, tenantId: tenant.id }, 'Scheduler: no handler for task');
      return false;
    }
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

    // 3. Acquire PostgreSQL advisory lock to prevent duplicate runs across workers
    const lockKey = `scheduler:${tenant.id}:${task.type}`;
    const { executed, result } = await this.schedulerRepo.withAdvisoryLock(lockKey, async () => {
      // Double check idempotency inside lock
      if (await this.schedulerRepo.hasSuccessfulRun(idempotencyKey)) {
        return false;
      }

      // Create RUNNING run record (unique idempotencyKey ensures DB constraint safety)
      const run = await this.schedulerRepo.createRun({
        tenantId: tenant.id,
        jobId: job.id,
        idempotencyKey,
      });

      try {
        // A system identity limited to this organization, not "the first ADMIN" (§5): tasks do not
        // depend on a person, and suspended organizations are already excluded by tick().
        const runResult = await handler.run({
          tenant,
          payload: resolveDynamicPayload(task.payload ?? {}, now),
          now,
          actor: { kind: 'system', orgId: tenant.id, task: task.type },
        });

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
