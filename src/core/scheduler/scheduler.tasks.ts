import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { normalizeExportFilter } from '../practice/practice.export.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type { SystemActor } from '../authz/authorization.service.js';
import type { ComplianceService } from '../compliance/compliance.service.js';
import type { PracticeApplicationService } from '../practice/practice.application.service.js';
import type { SchedulerTaskType, Tenant } from '../tenant/tenant.store.js';

export type SchedulerTaskContext = {
  tenant: Tenant;
  /** Task payload with dynamic placeholders already resolved. */
  payload: Record<string, unknown>;
  now: Date;
  /** Who runs the task: the system identity of this organization, never a member. */
  actor: SystemActor;
};

/** A task type the scheduler can run. New task types are added by registering a handler. */
export interface SchedulerTaskHandler {
  readonly type: SchedulerTaskType;
  run(ctx: SchedulerTaskContext): Promise<Record<string, unknown>>;
}

/** Tenant-wide practice export, written to the outbox for delivery. */
export class ExportPracticesTask implements SchedulerTaskHandler {
  readonly type = 'EXPORT_PRACTICES' as const;
  private readonly outbox: OutboxRepository;

  constructor(
    prisma: PrismaLike,
    private readonly practiceService: Pick<PracticeApplicationService, 'exportPractices'>,
  ) {
    this.outbox = new OutboxRepository(prisma);
  }

  async run({ tenant, payload, now }: SchedulerTaskContext): Promise<Record<string, unknown>> {
    const filter = normalizeExportFilter(payload);

    // Tenant-wide export: no userId, so practices of every tenant user are included.
    const exported = await this.practiceService.exportPractices({ tenantId: tenant.id, filter });

    await this.outbox.createMessage({
      tenantId: tenant.id,
      eventType: 'PRACTICE_EXPORT_GENERATED',
      payload: {
        title: exported.title,
        csv: exported.csv,
        practiceCount: exported.count,
        filter: exported.filter,
        generatedAt: now.toISOString(),
      },
    });

    return {
      title: exported.title,
      practiceCount: exported.count,
      filter: exported.filter,
    };
  }
}

/** Daily compliance check: enqueues the 30/15/7/1-day and due-date reminders. */
export class ComplianceDeadlinesTask implements SchedulerTaskHandler {
  readonly type = 'CHECK_COMPLIANCE_DEADLINES' as const;

  constructor(private readonly compliance: Pick<ComplianceService, 'sendDueReminders'>) {}

  async run({ tenant, now }: SchedulerTaskContext): Promise<Record<string, unknown>> {
    return this.compliance.sendDueReminders({ tenantId: tenant.id, now });
  }
}
