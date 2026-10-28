import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike, PrismaTx } from '../types/prisma.js';
import type { SchedulerJob, SchedulerRun } from '@prisma/client';

// Upper bound for a locked scheduler task. Generous on purpose: when the guarding transaction
// times out the lock is released, and another worker could start the same task while it runs.
const DEFAULT_LOCK_TIMEOUT_MS = 60 * 60_000;

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
   * Try to acquire a PostgreSQL transaction-level advisory lock on the given transaction.
   * The lock is released automatically by PostgreSQL on commit or rollback, so it can never
   * leak onto a pooled connection (session-level locks taken through the Prisma pool could be
   * released on a different connection than the one that acquired them).
   */
  private async tryAcquireXactLock(tx: PrismaTx, key: string): Promise<boolean> {
    try {
      const res = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint) as locked`,
        key,
      );
      return Boolean(res[0]?.locked);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to acquire advisory lock', err);
    }
  }

  /**
   * Executes `fn` guarded by an advisory lock held for the lifetime of a dedicated transaction.
   * Returns `{ executed: false }` without running `fn` if another worker holds the lock.
   * When the repository is already bound to a transaction client, the lock joins that transaction.
   */
  async withAdvisoryLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<{ executed: boolean; result?: T }> {
    let completed: { executed: true; result: T } | undefined;
    const run = async (tx: PrismaTx): Promise<{ executed: boolean; result?: T }> => {
      if (!(await this.tryAcquireXactLock(tx, key))) {
        return { executed: false };
      }
      completed = { executed: true, result: await fn() };
      return completed;
    };

    if (!('$transaction' in this.prisma)) {
      return run(this.prisma);
    }

    try {
      return await this.prisma.$transaction(run, {
        maxWait: 5_000,
        timeout: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      // `fn` writes through its own connections and has already committed: a lock transaction that
      // timed out while it ran must not turn a completed task into a reported failure.
      if (completed) return completed;
      throw err;
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
