import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike } from '../types/prisma.js';
import type { OutboxMessage } from '@prisma/client';

export type CreateOutboxMessageInput = {
  tenantId: string;
  eventType: string;
  payload: unknown;
};

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
}
