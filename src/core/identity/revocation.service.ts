import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import type { PrismaTx } from '../../data/types/prisma.js';
import type { PrismaClient, UserStatus } from '@prisma/client';

/**
 * Revocation (MF5): every change takes effect at the next request, because the principal is read
 * from the database each time (membership, person and organization status, auth_version,
 * session). Audit entries carry identifiers only; reasons stay on the membership.
 * docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §5.
 */

export class LastAdminError extends Error {
  readonly statusCode = 409;
  readonly code = 'LAST_ADMIN';
  constructor() {
    super('The last active administrator of an organization cannot be revoked');
    this.name = 'LastAdminError';
  }
}

type Actor = { userId: string | null };

async function auditEverywhere(
  tx: PrismaTx,
  userId: string,
  eventType: string,
  actor: Actor,
): Promise<void> {
  const memberships = await tx.membership.findMany({ where: { userId }, select: { orgId: true } });
  const audit = new AuditService(tx);
  for (const { orgId } of memberships) {
    await audit.logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType,
      payload: { targetUserId: userId },
    });
  }
}

/** Ends every session and every token of a person (auth_version + 1). */
export async function revokeAllSessions(
  prisma: PrismaClient,
  userId: string,
  actor: Actor,
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId },
      data: { authVersion: { increment: 1 } },
    });
    if (count !== 1) throw new NotFoundError('User not found');
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: 'revoked' },
    });
    await auditEverywhere(tx, userId, 'SESSIONS_REVOKED', actor);
  });
}

/** Suspends, disables or reactivates a person in every organization at once. */
export async function setUserStatus(
  prisma: PrismaClient,
  userId: string,
  status: UserStatus,
  actor: Actor,
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId },
      data: {
        status,
        // Leaving the active state also ends the open sessions and tokens.
        ...(status === 'ACTIVE' ? {} : { authVersion: { increment: 1 } }),
      },
    });
    if (count !== 1) throw new NotFoundError('User not found');
    if (status !== 'ACTIVE') {
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: `user ${status.toLowerCase()}` },
      });
    }
    await auditEverywhere(tx, userId, `USER_${status}`, actor);
  });
}

/** Revokes a membership; the last active ADMIN of an organization cannot be revoked. */
export async function revokeMembership(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  actor: Actor,
  reason?: string,
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { status: true },
    });
    if (!membership) throw new NotFoundError('Membership not found');
    if (membership.status === 'REVOKED') return;
    // Locks the active administrators: two administrators revoking each other at the same time
    // cannot leave the organization without one.
    const admins = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT "user_id" FROM "membership"
       WHERE "org_id" = ${orgId}::uuid AND "role" = 'ADMIN' AND "status" = 'ACTIVE'
         FOR UPDATE`;
    if (admins.length === 1 && admins[0].user_id === userId) throw new LastAdminError();
    await tx.membership.update({
      where: { userId_orgId: { userId, orgId } },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: actor.userId,
        revocationReason: reason?.slice(0, 500) ?? null,
      },
    });
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: 'MEMBERSHIP_REVOKED',
      payload: { targetUserId: userId },
    });
  });
}

export async function reactivateMembership(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  actor: Actor,
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const { count } = await tx.membership.updateMany({
      where: { userId, orgId, status: { not: 'ACTIVE' } },
      data: { status: 'ACTIVE', revokedAt: null, revokedBy: null, revocationReason: null },
    });
    if (count === 0) {
      const exists = await tx.membership.count({ where: { userId, orgId } });
      if (exists === 0) throw new NotFoundError('Membership not found');
      return;
    }
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: 'MEMBERSHIP_REACTIVATED',
      payload: { targetUserId: userId },
    });
  });
}

/** Members of an organization, for its administrators (no contact data beyond the email). */
export async function listMembers(prisma: PrismaClient, orgId: string) {
  const rows = await prisma.membership.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    select: {
      userId: true,
      role: true,
      status: true,
      createdAt: true,
      revokedAt: true,
      user: { select: { email: true, status: true } },
    },
  });
  return rows.map((r) => ({
    userId: r.userId,
    role: r.role,
    status: r.status,
    personStatus: r.user.status,
    // Placeholder emails of accounts created by chat are not shown as contacts.
    email: r.user.email.endsWith('@local.invalid') ? null : r.user.email,
    since: r.createdAt,
    revokedAt: r.revokedAt,
  }));
}
