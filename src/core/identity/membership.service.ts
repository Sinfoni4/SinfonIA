import type { PrismaLike } from '../../data/types/prisma.js';
import type { ChannelType, UserRole } from '@prisma/client';

/**
 * Who a person is and where they belong (MF4): a chat account leads to one person through an
 * active channel identity; the person belongs to organizations through ACTIVE memberships. A
 * suspended or disabled person, or a suspended organization, gives no access.
 * docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2.
 */

export type MembershipOption = { tenantId: string; tenantName: string; role: UserRole };

export type ChannelMemberships = { userId: string; options: MembershipOption[] };

/** Thrown when a chat user belongs to several organizations and none is selected yet. */
export class OrganizationChoiceRequiredError extends Error {
  constructor(
    readonly userId: string,
    readonly options: MembershipOption[],
  ) {
    super('ORGANIZATION_CHOICE_REQUIRED');
    this.name = 'OrganizationChoiceRequiredError';
  }
}

const activeMembership = (orgId?: string) => ({
  status: 'ACTIVE' as const,
  org: { status: 'ACTIVE' as const },
  ...(orgId ? { orgId } : {}),
});

/** Active person and active memberships behind a chat account; null when not linked or disabled. */
export async function findChannelMemberships(
  prisma: PrismaLike,
  channel: ChannelType,
  externalId: string,
): Promise<ChannelMemberships | null> {
  const identity = await prisma.channelIdentity.findFirst({
    where: { channel, externalId: externalId.trim(), revokedAt: null, user: { status: 'ACTIVE' } },
    select: {
      userId: true,
      user: {
        select: {
          memberships: {
            where: activeMembership(),
            orderBy: { createdAt: 'asc' },
            select: { orgId: true, role: true, org: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!identity) return null;
  return {
    userId: identity.userId,
    options: identity.user.memberships.map((m) => ({
      tenantId: m.orgId,
      tenantName: m.org.name,
      role: m.role,
    })),
  };
}

/** True when the person is an active member of an active organization. */
export async function isActiveMember(
  prisma: PrismaLike,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.membership.findFirst({
    where: { ...activeMembership(tenantId), userId, user: { status: 'ACTIVE' } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * External ids (Telegram chats, WhatsApp numbers) of the active ADMINs of an organization plus the
 * given extra users, through their active links, each once.
 */
export async function chatRecipients(
  prisma: PrismaLike,
  tenantId: string,
  channel: ChannelType,
  extraUserIds: string[] = [],
): Promise<string[]> {
  const rows = await prisma.channelIdentity.findMany({
    where: {
      channel,
      revokedAt: null,
      user: {
        status: 'ACTIVE',
        memberships: {
          some: {
            ...activeMembership(tenantId),
            OR: [
              { role: 'ADMIN' },
              ...(extraUserIds.length ? [{ userId: { in: extraUserIds } }] : []),
            ],
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { externalId: true },
  });
  return [...new Set(rows.map((r) => r.externalId))];
}

/**
 * Chat accounts that receive the scheduled export (D5b option b): active ADMINs of an active
 * organization who chose it, through an active link. Checked at every delivery, so a lost role,
 * membership or link stops it.
 */
export async function scheduledExportRecipients(
  prisma: PrismaLike,
  tenantId: string,
  channel: ChannelType,
): Promise<Array<{ userId: string; externalId: string }>> {
  const rows = await prisma.channelIdentity.findMany({
    where: {
      channel,
      revokedAt: null,
      user: {
        status: 'ACTIVE',
        memberships: {
          some: {
            ...activeMembership(tenantId),
            role: 'ADMIN',
            scheduledExportSince: { not: null },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, externalId: true },
  });
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.externalId) && seen.add(r.externalId));
}

/** First active ADMIN of an organization (scheduled tasks run on its behalf), or null. */
export async function firstActiveAdmin(
  prisma: PrismaLike,
  tenantId: string,
): Promise<string | null> {
  const row = await prisma.membership.findFirst({
    where: { ...activeMembership(tenantId), role: 'ADMIN', user: { status: 'ACTIVE' } },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/**
 * Adds a person to an organization through a legacy invite code. A revoked or suspended
 * membership is never reactivated this way: returns false.
 */
export async function joinWithLegacyInvite(
  prisma: PrismaLike,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const existing = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId: tenantId } },
    select: { status: true },
  });
  if (existing) return existing.status === 'ACTIVE';
  await prisma.membership.create({ data: { userId, orgId: tenantId, role: 'MEMBER' } });
  return true;
}
