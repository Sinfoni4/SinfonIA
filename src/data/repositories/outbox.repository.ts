import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike } from '../types/prisma.js';
import type { OutboxMessage, Prisma } from '@prisma/client';

export type CreateOutboxMessageInput = {
  tenantId: string;
  eventType: string;
  payload: unknown;
};

export type ClaimedOutboxMessage = {
  id: string;
  tenantId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  claimToken: string;
  deliveredTargets: string[];
  createdAt: Date;
};

// Updates after a claim only apply while the claim is still ours: same token, still PROCESSING.
type ClaimRef = { id: string; claimToken: string };

export class OutboxRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createMessage(
    input: CreateOutboxMessageInput,
    client?: PrismaLike,
  ): Promise<OutboxMessage> {
    requireTenantId(input.tenantId);
    const db = client ?? this.prisma;
    try {
      return await db.outboxMessage.create({
        data: {
          tenantId: input.tenantId,
          eventType: input.eventType,
          payload: input.payload as never,
          status: 'PENDING',
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create outbox message', err);
    }
  }

  async getPendingMessages(limit = 50): Promise<OutboxMessage[]> {
    try {
      return await this.prisma.outboxMessage.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to fetch pending outbox messages', err);
    }
  }

  async markProcessed(id: string, client?: PrismaLike): Promise<void> {
    const db = client ?? this.prisma;
    try {
      await db.outboxMessage.update({
        where: { id },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          error: null,
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to mark outbox message as processed', err);
    }
  }

  async markFailed(id: string, error: string, client?: PrismaLike): Promise<void> {
    const db = client ?? this.prisma;
    try {
      await db.outboxMessage.update({
        where: { id },
        data: {
          status: 'FAILED',
          error,
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to mark outbox message as failed', err);
    }
  }

  /**
   * Claims up to `limit` due messages for delivery. `FOR UPDATE SKIP LOCKED` lets several workers
   * claim in parallel without overlap; the lease makes a message reclaimable if its worker dies.
   */
  async claimDue(options: {
    now: Date;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedOutboxMessage[]> {
    const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
    try {
      return await this.prisma.$queryRaw<ClaimedOutboxMessage[]>`
        UPDATE "outbox_message" AS m
        SET "status" = 'PROCESSING',
            "attempts" = m."attempts" + 1,
            "claim_token" = gen_random_uuid(),
            "locked_until" = ${leaseUntil},
            "updated_at" = ${options.now}
        WHERE m."id" IN (
          SELECT "id" FROM "outbox_message"
          WHERE ("status" IN ('PENDING', 'FAILED') AND "next_attempt_at" <= ${options.now})
             OR ("status" = 'PROCESSING' AND "locked_until" < ${options.now})
          ORDER BY "next_attempt_at"
          LIMIT ${options.limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING m."id", m."tenant_id" AS "tenantId", m."event_type" AS "eventType", m."payload",
                  m."attempts", m."claim_token" AS "claimToken",
                  m."delivered_targets" AS "deliveredTargets", m."created_at" AS "createdAt"`;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to claim outbox messages', err);
    }
  }

  /** Renews the lease of a claim; false when the claim was lost. */
  async extendLease(claim: ClaimRef, lockedUntil: Date): Promise<boolean> {
    return this.updateClaimed(claim, { lockedUntil }, 'extend lease of');
  }

  async recordDeliveredTarget(claim: ClaimRef, target: string): Promise<boolean> {
    return this.updateClaimed(claim, { deliveredTargets: { push: target } }, 'record delivery');
  }

  async completeClaim(claim: ClaimRef, now: Date): Promise<boolean> {
    return this.updateClaimed(
      claim,
      { status: 'PROCESSED', processedAt: now, lockedUntil: null, claimToken: null, error: null },
      'complete',
    );
  }

  async scheduleRetry(claim: ClaimRef, nextAttemptAt: Date, error: string): Promise<boolean> {
    return this.updateClaimed(
      claim,
      { status: 'FAILED', nextAttemptAt, lockedUntil: null, claimToken: null, error },
      'schedule retry for',
    );
  }

  async moveToDeadLetter(claim: ClaimRef, error: string): Promise<boolean> {
    return this.updateClaimed(
      claim,
      { status: 'DEAD_LETTER', lockedUntil: null, claimToken: null, error },
      'dead-letter',
    );
  }

  /** Puts a dead-lettered message back in the queue (after fixing its cause). Keeps delivered targets. */
  async requeueDeadLetter(id: string, now = new Date()): Promise<boolean> {
    try {
      const { count } = await this.prisma.outboxMessage.updateMany({
        where: { id, status: 'DEAD_LETTER' },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: now, error: null },
      });
      return count === 1;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to requeue outbox message', err);
    }
  }

  private async updateClaimed(
    claim: ClaimRef,
    data: Prisma.OutboxMessageUpdateManyMutationInput,
    action: string,
  ): Promise<boolean> {
    try {
      const { count } = await this.prisma.outboxMessage.updateMany({
        where: { id: claim.id, status: 'PROCESSING', claimToken: claim.claimToken },
        data,
      });
      return count === 1;
    } catch (err: unknown) {
      throw new DatabaseError(`Failed to ${action} outbox message`, err);
    }
  }
}
