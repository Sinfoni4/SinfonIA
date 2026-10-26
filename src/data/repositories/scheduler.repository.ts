import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike } from '../types/prisma.js';
import type { SchedulerJob, SchedulerRun } from '@prisma/client';

export type CreateSchedulerJobInput = {
  tenantId: string;
  taskType: string;
  frequency?: string;
  payload?: unknown;
  nextRunAt?: Date;
};

export class SchedulerRepository {
  constructor(private readonly prisma: PrismaLike) {}

  /**
   * Acquire a PostgreSQL session-level advisory lock using a hash of the key.
   * Returns true if the lock was successfully acquired, false if held by another worker.
   */
  async tryAcquireAdvisoryLock(key: string, client?: PrismaLike): Promise<boolean> {
    const db = client ?? this.prisma;
    try {
      const res = await db.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint) as locked`,
        key,
      );
      return Boolean(res[0]?.locked);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to acquire advisory lock', err);
    }
  }

  /**
   * Release a previously acquired PostgreSQL session-level advisory lock.
   */
  async releaseAdvisoryLock(key: string, client?: PrismaLike): Promise<boolean> {
    const db = client ?? this.prisma;
    try {
      const res = await db.$queryRawUnsafe<Array<{ unlocked: boolean }>>(
        `SELECT pg_advisory_unlock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint) as unlocked`,
        key,
      );
      return Boolean(res[0]?.unlocked);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to release advisory lock', err);
    }
  }

  /**
   * Helper that executes `fn` guarded by an advisory lock.
   * Guarantees the lock is always released in the finally block.
   */
  async withAdvisoryLock<T>(
    key: string,
    fn: () => Promise<T>,
    client?: PrismaLike,
  ): Promise<{ executed: boolean; result?: T }> {
    const acquired = await this.tryAcquireAdvisoryLock(key, client);
    if (!acquired) {
      return { executed: false };
    }
    try {
      const result = await fn();
      return { executed: true, result };
    } finally {
      await this.releaseAdvisoryLock(key, client);
    }
  }

  async findOrCreateJob(
    input: CreateSchedulerJobInput,
    client?: PrismaLike,
  ): Promise<SchedulerJob> {
    requireTenantId(input.tenantId);
    const db = client ?? this.prisma;
    try {
      const existing = await db.schedulerJob.findFirst({
        where: {
          tenantId: input.tenantId,
          taskType: input.taskType,
        },
      });

      if (existing) {
        return existing;
      }

      return await db.schedulerJob.create({
        data: {
          tenantId: input.tenantId,
          taskType: input.taskType,
          frequency: input.frequency ?? 'monthly',
          payload: (input.payload ?? null) as never,
          nextRunAt: input.nextRunAt ?? null,
          enabled: true,
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find or create scheduler job', err);
    }
  }

  async updateJobRunTimestamps(
    jobId: string,
    lastRunAt: Date,
    nextRunAt: Date,
    client?: PrismaLike,
  ): Promise<void> {
    const db = client ?? this.prisma;
    try {
      await db.schedulerJob.update({
        where: { id: jobId },
        data: { lastRunAt, nextRunAt },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to update scheduler job run timestamps', err);
    }
  }

  async findRunByIdempotencyKey(
    idempotencyKey: string,
    client?: PrismaLike,
  ): Promise<SchedulerRun | null> {
    const db = client ?? this.prisma;
    try {
      return await db.schedulerRun.findUnique({
        where: { idempotencyKey },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find scheduler run by idempotency key', err);
    }
  }

  async hasSuccessfulRun(idempotencyKey: string, client?: PrismaLike): Promise<boolean> {
    const run = await this.findRunByIdempotencyKey(idempotencyKey, client);
    return run?.status === 'COMPLETED';
  }

  async createRun(
    data: {
      tenantId: string;
      jobId?: string;
      idempotencyKey: string;
    },
    client?: PrismaLike,
  ): Promise<SchedulerRun> {
    requireTenantId(data.tenantId);
    const db = client ?? this.prisma;
    try {
      return await db.schedulerRun.create({
        data: {
          tenantId: data.tenantId,
          jobId: data.jobId ?? null,
          idempotencyKey: data.idempotencyKey,
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create scheduler run', err);
    }
  }

  async completeRun(runId: string, result?: unknown, client?: PrismaLike): Promise<void> {
    const db = client ?? this.prisma;
    try {
      await db.schedulerRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          result: (result ?? null) as never,
          error: null,
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to complete scheduler run', err);
    }
  }

  async failRun(runId: string, error: string, client?: PrismaLike): Promise<void> {
    const db = client ?? this.prisma;
    try {
      await db.schedulerRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          error,
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to fail scheduler run', err);
    }
  }
}
