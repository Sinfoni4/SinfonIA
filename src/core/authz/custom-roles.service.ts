import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import {
  customRoleProblems,
  parseCustomPermissions,
  serializeCustomPermissions,
  type CustomPermissions,
} from './permissions.js';

import type { PrismaTx } from '../../data/types/prisma.js';
import type { PrismaClient, UserRole } from '@prisma/client';

/**
 * B2 (H6, docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.5): roles an organization defines for its
 * members, managed by its administrators. A custom role is built on a base role and keeps only
 * some of its permissions, or narrows them to the person's own practices: it can never give more
 * than the base role. It applies on every channel at the next request (authorize()).
 */

export class CustomRoleError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 = 400,
    readonly code = 'CUSTOM_ROLE_INVALID',
  ) {
    super(message);
    this.name = 'CustomRoleError';
  }
}

export type CustomRoleView = {
  id: string;
  name: string;
  baseRole: UserRole;
  permissions: CustomPermissions;
  members: number;
  createdAt: Date;
  updatedAt: Date;
};

type Actor = { userId: string };

const MANAGE = 'members.manage';

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > 60) {
    throw new CustomRoleError('Il nome del ruolo deve avere da 2 a 60 caratteri');
  }
  return trimmed;
}

function checkPermissions(baseRole: UserRole, permissions: CustomPermissions): void {
  const problems = customRoleProblems(baseRole, permissions);
  if (problems.length > 0) throw new CustomRoleError(problems.join('; '));
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * At least one active ADMIN must still be able to manage the members, or nobody could undo a
 * mistake. Checked inside the transaction of every change that could take it away.
 */
export async function ensureMemberManager(tx: PrismaTx, orgId: string): Promise<void> {
  const admins = await tx.membership.findMany({
    where: { orgId, status: 'ACTIVE', role: 'ADMIN', user: { status: 'ACTIVE' } },
    select: { customRole: { select: { permissions: true } } },
  });
  const managers = admins.filter(
    (a) => !a.customRole || parseCustomPermissions(a.customRole.permissions)[MANAGE] !== undefined,
  );
  if (managers.length === 0) {
    throw new CustomRoleError(
      'Almeno un amministratore attivo deve poter gestire le persone',
      409,
      'LAST_MEMBER_MANAGER',
    );
  }
}

function toView(row: {
  id: string;
  name: string;
  baseRole: UserRole;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
  _count: { memberships: number };
}): CustomRoleView {
  return {
    id: row.id,
    name: row.name,
    baseRole: row.baseRole,
    permissions: parseCustomPermissions(row.permissions),
    members: row._count.memberships,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const VIEW_SELECT = {
  id: true,
  name: true,
  baseRole: true,
  permissions: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { memberships: { where: { status: 'ACTIVE' as const } } } },
} as const;

export async function listCustomRoles(
  prisma: PrismaClient,
  orgId: string,
): Promise<CustomRoleView[]> {
  const rows = await prisma.orgRole.findMany({
    where: { orgId },
    orderBy: { name: 'asc' },
    select: VIEW_SELECT,
  });
  return rows.map(toView);
}

export async function createCustomRole(
  prisma: PrismaClient,
  orgId: string,
  input: { name: string; baseRole: UserRole; permissions: CustomPermissions },
  actor: Actor,
): Promise<CustomRoleView> {
  const name = cleanName(input.name);
  checkPermissions(input.baseRole, input.permissions);
  try {
    return await withTransaction(prisma, async (tx) => {
      const row = await tx.orgRole.create({
        data: {
          orgId,
          name,
          baseRole: input.baseRole,
          permissions: serializeCustomPermissions(input.permissions),
          createdBy: actor.userId,
        },
        select: VIEW_SELECT,
      });
      await new AuditService(tx).logEvent({
        tenantId: orgId,
        userId: actor.userId,
        eventType: 'CUSTOM_ROLE_CREATED',
        payload: { roleId: row.id, name, baseRole: input.baseRole },
      });
      return toView(row);
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new CustomRoleError(`Esiste già un ruolo «${name}»`, 409, 'CUSTOM_ROLE_EXISTS');
    }
    throw err;
  }
}

/** Renames a role or changes its permissions; the base role stays (its members have it). */
export async function updateCustomRole(
  prisma: PrismaClient,
  orgId: string,
  roleId: string,
  input: { name?: string; permissions?: CustomPermissions },
  actor: Actor,
): Promise<CustomRoleView> {
  try {
    return await withTransaction(prisma, async (tx) => {
      const current = await tx.orgRole.findFirst({
        where: { id: roleId, orgId },
        select: { baseRole: true },
      });
      if (!current) throw new NotFoundError('Custom role not found');
      const name = input.name !== undefined ? cleanName(input.name) : undefined;
      if (input.permissions) checkPermissions(current.baseRole, input.permissions);
      const row = await tx.orgRole.update({
        where: { id: roleId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(input.permissions
            ? { permissions: serializeCustomPermissions(input.permissions) }
            : {}),
        },
        select: VIEW_SELECT,
      });
      await ensureMemberManager(tx, orgId);
      await new AuditService(tx).logEvent({
        tenantId: orgId,
        userId: actor.userId,
        eventType: 'CUSTOM_ROLE_UPDATED',
        payload: { roleId, name: row.name },
      });
      return toView(row);
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new CustomRoleError('Esiste già un ruolo con questo nome', 409, 'CUSTOM_ROLE_EXISTS');
    }
    throw err;
  }
}

/** Deletes a role no active member has; revoked memberships that had it go back to the base. */
export async function deleteCustomRole(
  prisma: PrismaClient,
  orgId: string,
  roleId: string,
  actor: Actor,
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const role = await tx.orgRole.findFirst({
      where: { id: roleId, orgId },
      select: { name: true },
    });
    if (!role) throw new NotFoundError('Custom role not found');
    const active = await tx.membership.count({
      where: { customRoleId: roleId, status: 'ACTIVE' },
    });
    if (active > 0) {
      throw new CustomRoleError(
        'Il ruolo è assegnato a qualcuno: toglilo prima alle persone',
        409,
        'CUSTOM_ROLE_IN_USE',
      );
    }
    await tx.membership.updateMany({
      where: { customRoleId: roleId },
      data: { customRoleId: null },
    });
    await tx.orgRole.delete({ where: { id: roleId } });
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: 'CUSTOM_ROLE_DELETED',
      payload: { roleId, name: role.name },
    });
  });
}

/**
 * Gives an active member a custom role of the organization (null: back to the base role). The
 * role must be built on the member's base role.
 */
export async function setMemberCustomRole(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  roleId: string | null,
  actor: Actor,
): Promise<{ customRoleId: string | null }> {
  return withTransaction(prisma, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { status: true, role: true, customRoleId: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new NotFoundError('Membership not found');
    }
    if (membership.customRoleId === roleId) return { customRoleId: roleId };
    let name: string | null = null;
    if (roleId) {
      const role = await tx.orgRole.findFirst({
        where: { id: roleId, orgId },
        select: { name: true, baseRole: true },
      });
      if (!role) throw new NotFoundError('Custom role not found');
      if (role.baseRole !== membership.role) {
        throw new CustomRoleError(
          'Il ruolo personalizzato deve partire dal ruolo della persona',
          400,
          'CUSTOM_ROLE_BASE_MISMATCH',
        );
      }
      name = role.name;
    }
    await tx.membership.update({
      where: { userId_orgId: { userId, orgId } },
      data: { customRoleId: roleId },
    });
    await ensureMemberManager(tx, orgId);
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: 'MEMBER_CUSTOM_ROLE_CHANGED',
      payload: { targetUserId: userId, roleId, name },
    });
    return { customRoleId: roleId };
  });
}
