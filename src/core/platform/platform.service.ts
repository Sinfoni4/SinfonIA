import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import type { LoginService } from '../identity/login.service.js';
import type { OrganizationStatus, OrganizationType, Prisma, PrismaClient } from '@prisma/client';

/**
 * The platform console (docs/PROGETTO_FRONTEND_V2.md §5, A1-A3 and A6; G3, G9): organizations
 * with counts, dates and administrator contacts only. This is the only module that reads across
 * organizations, and it never reads practices, attachments, deadlines or other people's data
 * (tests/fe7.platform-console.test.ts checks it). Every action goes to the platform audit log and,
 * when it concerns an organization, to that organization's activity log too.
 */

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

export class PlatformActionError extends Error {
  readonly statusCode = 409;
  readonly code = 'PLATFORM_ACTION_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'PlatformActionError';
  }
}

export type PlatformActor = { userId: string };

type Tx = Prisma.TransactionClient;

async function logPlatform(
  tx: Tx,
  entry: { actor: PlatformActor; action: string; orgId?: string; payload?: Prisma.InputJsonValue },
): Promise<void> {
  await tx.platformAuditLog.create({
    data: {
      actorUserId: entry.actor.userId,
      action: entry.action,
      orgId: entry.orgId ?? null,
      payload: entry.payload ?? {},
    },
  });
}

/** The organization sees what the platform did to it, without the name of the administrator. */
async function logInOrganization(tx: Tx, orgId: string, eventType: string): Promise<void> {
  await new AuditService(tx).logEvent({
    tenantId: orgId,
    userId: null,
    eventType,
    payload: { byPlatform: true },
  });
}

// --- A1: list -----------------------------------------------------------------------------------

export type OrganizationRow = {
  id: string;
  name: string;
  type: OrganizationType;
  status: OrganizationStatus;
  createdAt: Date;
  members: number;
  practices: number;
  lastActivityAt: Date | null;
};

export async function listOrganizations(
  prisma: PrismaClient,
  input: {
    page: number;
    limit: number;
    search?: string;
    type?: OrganizationType;
    status?: OrganizationStatus;
  },
): Promise<{ items: OrganizationRow[]; total: number; page: number; totalPages: number }> {
  const where: Prisma.TenantWhereInput = {
    ...(input.search ? { name: { contains: input.search, mode: 'insensitive' } } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: { id: true, name: true, type: true, status: true, createdAt: true },
    }),
  ]);
  const ids = rows.map((r) => r.id);
  const [members, practices, activity] = ids.length
    ? await Promise.all([
        prisma.membership.groupBy({
          by: ['orgId'],
          where: { orgId: { in: ids }, status: 'ACTIVE' },
          _count: { _all: true },
        }),
        prisma.practice.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids } },
          _count: { _all: true },
        }),
        prisma.auditLog.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids } },
          _max: { createdAt: true },
        }),
      ])
    : [[], [], []];
  const memberCount = new Map(members.map((m) => [m.orgId, m._count._all]));
  const practiceCount = new Map(practices.map((p) => [p.tenantId, p._count._all]));
  const lastActivity = new Map(activity.map((a) => [a.tenantId, a._max.createdAt]));
  return {
    items: rows.map((r) => ({
      ...r,
      members: memberCount.get(r.id) ?? 0,
      practices: practiceCount.get(r.id) ?? 0,
      lastActivityAt: lastActivity.get(r.id) ?? null,
    })),
    total,
    page: input.page,
    totalPages: Math.ceil(total / input.limit),
  };
}

// --- A3: detail ---------------------------------------------------------------------------------

export type OrganizationDetail = OrganizationRow & {
  module: string;
  scheduledExport: boolean;
  webhook: boolean;
  deactivatedAt: Date | null;
  /** G3: the contact of the active administrators, never other members. */
  administrators: Array<{ email: string | null; since: Date }>;
  pendingInvitations: number;
};

export async function getOrganization(
  prisma: PrismaClient,
  orgId: string,
  now = new Date(),
): Promise<OrganizationDetail> {
  const org = await prisma.tenant.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      createdAt: true,
      module: true,
      schedulerEnabled: true,
      integrationType: true,
      deactivatedAt: true,
    },
  });
  if (!org) throw new NotFoundError('Organization not found');
  const [members, practices, last, admins, pendingInvitations] = await Promise.all([
    prisma.membership.count({ where: { orgId, status: 'ACTIVE' } }),
    prisma.practice.count({ where: { tenantId: orgId } }),
    prisma.auditLog.aggregate({ where: { tenantId: orgId }, _max: { createdAt: true } }),
    prisma.membership.findMany({
      where: { orgId, status: 'ACTIVE', role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, user: { select: { email: true } } },
    }),
    prisma.invitation.count({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    }),
  ]);
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    status: org.status,
    createdAt: org.createdAt,
    members,
    practices,
    lastActivityAt: last._max.createdAt,
    module: org.module,
    scheduledExport: org.schedulerEnabled,
    webhook: org.integrationType === 'external',
    deactivatedAt: org.deactivatedAt,
    administrators: admins.map((a) => ({
      email: PLACEHOLDER_EMAIL.test(a.user.email) ? null : a.user.email,
      since: a.createdAt,
    })),
    pendingInvitations,
  };
}

// --- A2: new organization -----------------------------------------------------------------------

export async function createOrganization(
  prisma: PrismaClient,
  login: Pick<LoginService, 'createInvitation'>,
  input: { name: string; type: OrganizationType; firstAdminEmail: string },
  actor: PlatformActor,
): Promise<{ orgId: string; invitationId: string; devToken?: string }> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new PlatformActionError('Il nome deve avere da 2 a 120 caratteri');
  }
  const exists = await prisma.tenant.count({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (exists > 0) throw new PlatformActionError('Esiste già un’organizzazione con questo nome');
  const org = await withTransaction(prisma, async (tx) => {
    const created = await tx.tenant.create({
      data: { name, type: input.type },
      select: { id: true },
    });
    await logPlatform(tx, {
      actor,
      action: 'ORGANIZATION_CREATED',
      orgId: created.id,
      payload: { name, type: input.type },
    });
    await logInOrganization(tx, created.id, 'ORGANIZATION_CREATED');
    return created;
  });
  // The first administrator gets a normal invitation: the platform never creates accounts.
  const invitation = await login.createInvitation(org.id, input.firstAdminEmail, 'ADMIN', {
    userId: actor.userId,
    platform: true,
  });
  await prisma.platformAuditLog.create({
    data: {
      actorUserId: actor.userId,
      action: 'FIRST_ADMIN_INVITED',
      orgId: org.id,
      payload: { invitationId: invitation.invitationId },
    },
  });
  return { orgId: org.id, ...invitation };
}

// --- A3: suspension (G9) ------------------------------------------------------------------------

/**
 * Suspends or reactivates an organization. Suspension blocks its members at once on dashboard,
 * API and chat (the authorization checks the organization status at every request) and stops
 * its scheduled tasks; no data is touched.
 */
export async function setOrganizationSuspended(
  prisma: PrismaClient,
  orgId: string,
  suspended: boolean,
  actor: PlatformActor,
  reason?: string,
): Promise<{ status: OrganizationStatus }> {
  const from: OrganizationStatus = suspended ? 'ACTIVE' : 'SUSPENDED';
  const to: OrganizationStatus = suspended ? 'SUSPENDED' : 'ACTIVE';
  await withTransaction(prisma, async (tx) => {
    const org = await tx.tenant.findUnique({ where: { id: orgId }, select: { status: true } });
    if (!org) throw new NotFoundError('Organization not found');
    const changed = await tx.tenant.updateMany({
      where: { id: orgId, status: from },
      data: { status: to },
    });
    if (changed.count !== 1) {
      throw new PlatformActionError(
        suspended
          ? 'Si sospende solo un’organizzazione attiva'
          : 'Si riattiva solo un’organizzazione sospesa',
      );
    }
    const action = suspended ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_REACTIVATED';
    await logPlatform(tx, {
      actor,
      action,
      orgId,
      payload: reason ? { reason } : {},
    });
    await logInOrganization(tx, orgId, action);
  });
  return { status: to };
}

// --- A6: platform audit log ---------------------------------------------------------------------

export type PlatformAuditRow = {
  id: string;
  at: Date;
  action: string;
  actorEmail: string | null;
  organization: { id: string; name: string | null } | null;
  /** The person a role change is about (another platform administrator). */
  targetEmail: string | null;
  details: Partial<Record<'name' | 'type' | 'reason' | 'via', string>>;
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listPlatformAudit(
  prisma: PrismaClient,
  input: { page: number; limit: number; orgId?: string },
): Promise<{ items: PlatformAuditRow[]; total: number; page: number; totalPages: number }> {
  const where: Prisma.PlatformAuditLogWhereInput = input.orgId ? { orgId: input.orgId } : {};
  const [total, rows] = await Promise.all([
    prisma.platformAuditLog.count({ where }),
    prisma.platformAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    }),
  ]);
  const targetOf = (payload: unknown) => {
    const target = recordOf(payload).targetUserId;
    return typeof target === 'string' ? target : null;
  };
  const actorIds = [
    ...new Set(
      rows.flatMap((r) => [r.actorUserId, targetOf(r.payload)]).filter((id): id is string => !!id),
    ),
  ];
  const orgIds = [...new Set(rows.map((r) => r.orgId).filter((id): id is string => !!id))];
  const [actors, orgs] = await Promise.all([
    actorIds.length
      ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
      : Promise.resolve([]),
    orgIds.length
      ? prisma.tenant.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const emails = new Map(actors.map((a) => [a.id, a.email]));
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  return {
    items: rows.map((r) => {
      const payload = recordOf(r.payload);
      const target = targetOf(r.payload);
      const details: PlatformAuditRow['details'] = {};
      for (const key of ['name', 'type', 'reason', 'via'] as const) {
        if (typeof payload[key] === 'string') details[key] = payload[key];
      }
      return {
        id: r.id,
        at: r.createdAt,
        action: r.action,
        actorEmail: r.actorUserId ? (emails.get(r.actorUserId) ?? null) : null,
        organization: r.orgId ? { id: r.orgId, name: names.get(r.orgId) ?? null } : null,
        targetEmail: target ? (emails.get(target) ?? null) : null,
        details,
      };
    }),
    total,
    page: input.page,
    totalPages: Math.ceil(total / input.limit),
  };
}
