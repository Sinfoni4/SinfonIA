import { NotFoundError } from '../../data/errors/errors.js';
import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type { PrismaClient, UserRole } from '@prisma/client';

/**
 * AGX-03: the holder of a practice, the person it was opened for (a farmer whose practice the
 * staff opens). The holder reaches the practice as its creator does: sees it, attaches documents,
 * hears its notices. Only who may assign practices (`practice.assign`) chooses the holder.
 * Deleting the practice stays with its creator.
 */

/** The new holder hears in chat that a practice was opened for them. */
export const PRACTICE_HOLDER_SET = 'PRACTICE_HOLDER_SET';

export type PracticeHolderSetPayload = { practiceId: string; userId: string };

export class HolderError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_HOLDER';
  constructor(message: string) {
    super(message);
    this.name = 'HolderError';
  }
}

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

/** Who hears the notices of a practice: its holder, or its creator when there is none. */
export function practiceRecipient(practice: {
  userId: string;
  holderUserId?: string | null;
}): string {
  return practice.holderUserId ?? practice.userId;
}

/** Whether the practice is the person's: created by them or opened for them. */
export function isPersonPractice(
  practice: { userId: string; holderUserId?: string | null },
  userId: string,
): boolean {
  return practice.userId === userId || practice.holderUserId === userId;
}

/** The people a practice can be opened for: the active members of the organization. */
export async function listHolderCandidates(
  prisma: PrismaClient,
  tenantId: string,
): Promise<Array<{ userId: string; email: string | null; role: UserRole }>> {
  const rows = await prisma.membership.findMany({
    where: { orgId: tenantId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, role: true, user: { select: { email: true } } },
  });
  return rows.map((r) => ({
    userId: r.userId,
    role: r.role,
    email: PLACEHOLDER_EMAIL.test(r.user.email) ? null : r.user.email,
  }));
}

/** Refuses a holder who is not an active member of the organization. */
export async function requireHolder(
  tx: PrismaLike,
  tenantId: string,
  holderUserId: string,
): Promise<void> {
  const member = await tx.membership.findFirst({
    where: { orgId: tenantId, userId: holderUserId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
    select: { id: true },
  });
  if (!member) {
    throw new HolderError('Il titolare deve essere una persona attiva della tua organizzazione');
  }
}

/** Queues the chat notice for a new holder, unless they set it themselves. */
export async function notifyNewHolder(
  tx: PrismaLike,
  input: { tenantId: string; practiceId: string; holderUserId: string; actorUserId: string },
): Promise<void> {
  if (input.holderUserId === input.actorUserId) return;
  await new OutboxRepository(tx).createMessage({
    tenantId: input.tenantId,
    eventType: PRACTICE_HOLDER_SET,
    payload: {
      practiceId: input.practiceId,
      userId: input.holderUserId,
    } satisfies PracticeHolderSetPayload,
  });
}

/**
 * Sets or removes the holder of a practice. Choosing its creator removes it, since the creator is
 * the holder by default. Audited with ids only; the new holder hears it in chat.
 */
export async function setPracticeHolder(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    /** null: the practice goes back to its creator. */
    holderUserId: string | null;
    actorUserId: string;
  },
): Promise<{ holderUserId: string | null }> {
  return withTransaction(prisma, async (tx) => {
    const practice = await tx.practice.findFirst({
      where: { id: input.practiceId, tenantId: input.tenantId },
      select: { userId: true, holderUserId: true },
    });
    if (!practice) throw new NotFoundError('Practice not found');
    const next = input.holderUserId === practice.userId ? null : input.holderUserId;
    if (next) await requireHolder(tx, input.tenantId, next);
    if (practice.holderUserId === next) return { holderUserId: next };

    await tx.practice.updateMany({
      where: { id: input.practiceId, tenantId: input.tenantId },
      data: { holderUserId: next },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'PRACTICE_HOLDER_CHANGED',
      // Without a target the practice went back to its creator.
      payload: { practiceId: input.practiceId, ...(next ? { targetUserId: next } : {}) },
    });
    if (next) {
      await notifyNewHolder(tx, {
        tenantId: input.tenantId,
        practiceId: input.practiceId,
        holderUserId: next,
        actorUserId: input.actorUserId,
      });
    }
    return { holderUserId: next };
  });
}
