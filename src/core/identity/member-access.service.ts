import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { can } from '../authz/authorization.service.js';
import { GRANTABLE_TENANT_SCOPES, tenantScopeKey, type Permission } from '../authz/permissions.js';

import type { PrismaClient } from '@prisma/client';

/**
 * What an ORG_ADMIN adds on top of a role (D5), and the choice of an ADMIN to receive the
 * scheduled export in chat (D5b option b). Both take effect at the next request or delivery and
 * are audited with identifiers only. docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §3.3.
 */

export class MemberAccessError extends Error {
  readonly statusCode = 409;
  readonly code = 'MEMBER_ACCESS_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'MemberAccessError';
  }
}

type Actor = { userId: string | null };

async function activeMembership(prisma: PrismaClient, orgId: string, userId: string) {
  const membership = await prisma.membership.findFirst({
    where: { orgId, userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
    select: { role: true, extraPermissions: true, scheduledExportSince: true },
  });
  if (!membership) throw new NotFoundError('Membership not found');
  return membership;
}

/** Grants or withdraws the organization-wide scope of a permission, where the catalog allows it. */
export async function setTenantScope(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  permission: Permission,
  granted: boolean,
  actor: Actor,
): Promise<void> {
  const key = tenantScopeKey(permission);
  await withTransaction(prisma, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { orgId, userId, status: 'ACTIVE' },
      select: { role: true, extraPermissions: true },
    });
    if (!membership) throw new NotFoundError('Membership not found');
    if (granted && GRANTABLE_TENANT_SCOPES[permission]?.includes(membership.role) !== true) {
      throw new MemberAccessError(`${permission} cannot be widened for this role`);
    }
    const has = membership.extraPermissions.includes(key);
    if (has === granted) return;
    await tx.membership.update({
      where: { userId_orgId: { userId, orgId } },
      data: {
        extraPermissions: granted
          ? [...membership.extraPermissions, key]
          : membership.extraPermissions.filter((p) => p !== key),
      },
    });
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: granted ? 'PERMISSION_GRANTED' : 'PERMISSION_WITHDRAWN',
      payload: { targetUserId: userId, permission: key },
    });
  });
}

/**
 * Turns the scheduled export in chat on or off for a person. Only the person turns it on, and only
 * as an ADMIN; the person or another ADMIN can turn it off. Returns whether it changed.
 */
export async function setScheduledExport(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  enabled: boolean,
  actor: Actor,
): Promise<boolean> {
  const membership = await activeMembership(prisma, orgId, userId);
  if (enabled) {
    if (actor.userId !== userId) {
      throw new MemberAccessError('Only the person can choose to receive the scheduled export');
    }
    if (!can(membership.role, 'members.manage')) {
      throw new MemberAccessError('Only administrators receive the scheduled export');
    }
  }
  if (Boolean(membership.scheduledExportSince) === enabled) return false;
  await withTransaction(prisma, async (tx) => {
    await tx.membership.update({
      where: { userId_orgId: { userId, orgId } },
      data: { scheduledExportSince: enabled ? new Date() : null },
    });
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: enabled ? 'SCHEDULED_EXPORT_ENABLED' : 'SCHEDULED_EXPORT_DISABLED',
      payload: { targetUserId: userId },
    });
  });
  return true;
}
