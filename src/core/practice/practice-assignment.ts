import { NotFoundError } from '../../data/errors/errors.js';
import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import type { PrismaClient, UserRole } from '@prisma/client';

/**
 * A4 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §5): who follows a practice. Only an active
 * administrator or operator of the organization can be assigned; the assignee hears it in chat.
 */

export const PRACTICE_ASSIGNED = 'PRACTICE_ASSIGNED';

export type PracticeAssignedPayload = { practiceId: string; userId: string };

const ASSIGNABLE_ROLES: UserRole[] = ['ADMIN', 'OPERATOR'];

export class AssignmentError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_ASSIGNEE';
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentError';
  }
}

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

/** The people a practice can be assigned to: active administrators and operators. */
export async function listAssignees(
  prisma: PrismaClient,
  tenantId: string,
): Promise<Array<{ userId: string; email: string | null; role: UserRole }>> {
  const rows = await prisma.membership.findMany({
    where: {
      orgId: tenantId,
      status: 'ACTIVE',
      role: { in: ASSIGNABLE_ROLES },
      user: { status: 'ACTIVE' },
    },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, role: true, user: { select: { email: true } } },
  });
  return rows.map((r) => ({
    userId: r.userId,
    role: r.role,
    email: PLACEHOLDER_EMAIL.test(r.user.email) ? null : r.user.email,
  }));
}

export async function assignPractice(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    /** null gives the practice back to nobody. */
    assigneeUserId: string | null;
    actorUserId: string;
  },
): Promise<{ assignedTo: string | null; assignedAt: Date | null }> {
  return withTransaction(prisma, async (tx) => {
    const practice = await tx.practice.findFirst({
      where: { id: input.practiceId, tenantId: input.tenantId },
      select: { assignedTo: true },
    });
    if (!practice) throw new NotFoundError('Practice not found');
    if (input.assigneeUserId) {
      const member = await tx.membership.findFirst({
        where: {
          orgId: input.tenantId,
          userId: input.assigneeUserId,
          status: 'ACTIVE',
          role: { in: ASSIGNABLE_ROLES },
          user: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!member) {
        throw new AssignmentError(
          'Si può assegnare una pratica solo a un amministratore o a un operatore attivo',
        );
      }
    }
    if (practice.assignedTo === input.assigneeUserId) {
      const current = await tx.practice.findFirstOrThrow({
        where: { id: input.practiceId },
        select: { assignedTo: true, assignedAt: true },
      });
      return current;
    }
    const assignedAt = input.assigneeUserId ? new Date() : null;
    // Only the state of the assignment changes: not the version, so a transition in progress is
    // not refused because of it.
    await tx.practice.updateMany({
      where: { id: input.practiceId, tenantId: input.tenantId },
      data: { assignedTo: input.assigneeUserId, assignedAt },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'PRACTICE_ASSIGNED',
      payload: {
        practiceId: input.practiceId,
        ...(input.assigneeUserId ? { targetUserId: input.assigneeUserId } : { unassigned: true }),
      },
    });
    if (input.assigneeUserId && input.assigneeUserId !== input.actorUserId) {
      await new OutboxRepository(tx).createMessage({
        tenantId: input.tenantId,
        eventType: PRACTICE_ASSIGNED,
        payload: {
          practiceId: input.practiceId,
          userId: input.assigneeUserId,
        } satisfies PracticeAssignedPayload,
      });
    }
    return { assignedTo: input.assigneeUserId, assignedAt };
  });
}
