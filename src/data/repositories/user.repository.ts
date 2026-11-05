import { randomUUID } from 'node:crypto';

import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { UserDTO } from '../types/domain.js';
import type { PrismaLike, PrismaTx } from '../types/prisma.js';
import type { ChannelType, UserRole } from '@prisma/client';

/**
 * Links a chat account to a person (MF3, MF12): one active link per chat account and per person
 * on a channel; an older link of either is revoked, as the legacy resolver let the most recent
 * account win. `channel_identity` is the only place chat links are written.
 */
export async function linkChannelIdentity(
  db: PrismaLike,
  userId: string,
  channel: ChannelType,
  externalId: string,
): Promise<void> {
  const now = new Date();
  await db.channelIdentity.updateMany({
    where: {
      channel,
      revokedAt: null,
      OR: [
        { externalId, userId: { not: userId } },
        { userId, externalId: { not: externalId } },
      ],
    },
    data: { revokedAt: now },
  });
  const active = await db.channelIdentity.findFirst({
    where: { channel, externalId, userId, revokedAt: null },
    select: { id: true },
  });
  if (!active) await db.channelIdentity.create({ data: { userId, channel, externalId } });
}

export class UserRepository {
  constructor(private readonly prisma: PrismaLike) {}

  /** Runs in the caller's transaction, or in a new one from a root client. */
  private inTransaction<T>(fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return '$transaction' in this.prisma
      ? this.prisma.$transaction((tx) => fn(tx))
      : fn(this.prisma);
  }

  /**
   * Creates a person with an active membership of the organization: the membership is what
   * every check reads (MF4). Until the contraction migration (MF12 step 5) the old `user`
   * columns are still filled, because `tenant_id` cannot be empty; nothing reads them.
   * `telegramId` links a Telegram account through `channel_identity`.
   */
  async createUser(
    orgId: string,
    data: {
      email: string;
      role?: UserRole;
      telegramId?: string | null;
      emailVerifiedAt?: Date | null;
      invitedBy?: string | null;
    },
  ): Promise<UserDTO> {
    requireTenantId(orgId);
    const role = data.role ?? 'MEMBER';
    try {
      return await this.inTransaction(async (tx) => {
        const row = await tx.user.create({
          data: { email: data.email, emailVerifiedAt: data.emailVerifiedAt ?? null },
          select: { id: true, email: true, createdAt: true, updatedAt: true },
        });
        await tx.membership.upsert({
          where: { userId_orgId: { userId: row.id, orgId } },
          create: { userId: row.id, orgId, role, invitedBy: data.invitedBy ?? null },
          update: { role, status: 'ACTIVE', revokedAt: null, revokedBy: null },
        });
        const telegramId = data.telegramId?.trim();
        if (telegramId) await linkChannelIdentity(tx, row.id, 'TELEGRAM', telegramId);
        return { ...row, tenantId: orgId, role };
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create user', err);
    }
  }

  /**
   * The person behind a Telegram account in an organization, created the first time the
   * account is linked there with an invite code (MF12 step 2: through `channel_identity`).
   */
  async ensureTelegramUser(orgId: string, telegramId: string): Promise<UserDTO> {
    requireTenantId(orgId);
    const externalId = telegramId.trim();
    if (!externalId) {
      throw new DatabaseError('telegramId is required');
    }
    try {
      const linked = await this.prisma.channelIdentity.findFirst({
        where: {
          channel: 'TELEGRAM',
          externalId,
          revokedAt: null,
          user: { memberships: { some: { orgId } } },
        },
        select: {
          user: {
            select: {
              id: true,
              email: true,
              createdAt: true,
              updatedAt: true,
              memberships: { where: { orgId }, select: { role: true } },
            },
          },
        },
      });
      if (linked) {
        const { memberships, ...user } = linked.user;
        return { ...user, tenantId: orgId, role: memberships[0]?.role ?? 'MEMBER' };
      }
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find Telegram user', err);
    }
    return this.createUser(orgId, {
      email: `telegram-${randomUUID()}@local.invalid`,
      role: 'MEMBER',
      telegramId: externalId,
    });
  }
}
