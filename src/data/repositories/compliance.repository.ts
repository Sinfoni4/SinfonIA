import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike } from '../types/prisma.js';
import type {
  ComplianceCategory,
  ComplianceDeadline,
  ComplianceDeadlineStatus,
} from '@prisma/client';

export type ComplianceDeadlineDTO = ComplianceDeadline;

export type CreateComplianceDeadlineInput = {
  tenantId: string;
  userId?: string | null;
  createdBy?: string | null;
  category: ComplianceCategory;
  title: string;
  dueDate: Date;
  notes?: string | null;
};

export type ComplianceDeadlineFilter = {
  status?: ComplianceDeadlineStatus;
  category?: ComplianceCategory;
  userId?: string;
  dueBefore?: Date;
  limit?: number;
};

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export class ComplianceRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async create(input: CreateComplianceDeadlineInput): Promise<ComplianceDeadlineDTO> {
    requireTenantId(input.tenantId);
    try {
      return await this.prisma.complianceDeadline.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId ?? null,
          createdBy: input.createdBy ?? null,
          category: input.category,
          title: input.title,
          dueDate: input.dueDate,
          notes: input.notes ?? null,
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create compliance deadline', err);
    }
  }

  async list(tenantId: string, filter: ComplianceDeadlineFilter = {}) {
    requireTenantId(tenantId);
    try {
      return await this.prisma.complianceDeadline.findMany({
        where: {
          tenantId,
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.category ? { category: filter.category } : {}),
          ...(filter.userId ? { userId: filter.userId } : {}),
          ...(filter.dueBefore ? { dueDate: { lte: filter.dueBefore } } : {}),
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        ...(filter.limit ? { take: filter.limit } : {}),
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list compliance deadlines', err);
    }
  }

  async getById(tenantId: string, id: string): Promise<ComplianceDeadlineDTO> {
    requireTenantId(tenantId);
    const row = await this.prisma.complianceDeadline
      .findFirst({ where: { tenantId, id } })
      .catch((err: unknown) => {
        throw new DatabaseError('Failed to get compliance deadline', err);
      });
    if (!row) throw new NotFoundError('Compliance deadline not found');
    return row;
  }

  /** Ids of the tenant's deadlines whose id starts with `prefix` (short codes shown on Telegram). */
  async findIdsByPrefix(tenantId: string, prefix: string): Promise<string[]> {
    requireTenantId(tenantId);
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "compliance_deadline"
        WHERE "tenant_id" = ${tenantId}::uuid AND "id"::text LIKE ${`${prefix}%`}
        LIMIT 2`;
      return rows.map((r) => r.id);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find compliance deadline', err);
    }
  }

  async close(tenantId: string, id: string, now: Date): Promise<ComplianceDeadlineDTO> {
    requireTenantId(tenantId);
    try {
      const { count } = await this.prisma.complianceDeadline.updateMany({
        where: { tenantId, id, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: now },
      });
      if (count === 0) {
        // Not found, or already closed: report the current state either way.
        return await this.getById(tenantId, id);
      }
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to close compliance deadline', err);
    }
    return this.getById(tenantId, id);
  }

  /** Open deadlines due on or before `dueBefore`, across tenants or for one tenant/deadline. */
  async findDueOpen(filter: { dueBefore: Date; tenantId?: string; deadlineId?: string }) {
    try {
      return await this.prisma.complianceDeadline.findMany({
        where: {
          status: 'OPEN',
          dueDate: { lte: filter.dueBefore },
          ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
          ...(filter.deadlineId ? { id: filter.deadlineId } : {}),
        },
        orderBy: { dueDate: 'asc' },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find due compliance deadlines', err);
    }
  }

  /**
   * Records the reminder for (deadline, threshold) and enqueues its outbox message atomically.
   * Returns false when that reminder already exists: the unique key makes this exactly-once.
   */
  async createReminderOnce(input: {
    tenantId: string;
    deadlineId: string;
    thresholdDays: number;
    eventType: string;
    payload: unknown;
  }): Promise<boolean> {
    if (!('$transaction' in this.prisma)) {
      throw new DatabaseError('createReminderOnce requires a root Prisma client');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const message = await tx.outboxMessage.create({
          data: {
            tenantId: input.tenantId,
            eventType: input.eventType,
            payload: input.payload as never,
          },
        });
        await tx.complianceReminder.create({
          data: {
            tenantId: input.tenantId,
            deadlineId: input.deadlineId,
            thresholdDays: input.thresholdDays,
            outboxMessageId: message.id,
          },
        });
      });
      return true;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return false;
      throw new DatabaseError('Failed to create compliance reminder', err);
    }
  }
}
