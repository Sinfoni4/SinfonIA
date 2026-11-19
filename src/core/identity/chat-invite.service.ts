import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { NotFoundError } from '../../data/errors/errors.js';
import { UserRepository } from '../../data/repositories/user.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import { shortRef } from './channel-link.service.js';
import { CHAT_INVITE_EMAIL } from './login.service.js';

export { CHAT_INVITE_EMAIL };

import type { LinkResult } from './channel-link.service.js';
import type { PrismaTx } from '../../data/types/prisma.js';
import type { PrismaClient, UserRole } from '@prisma/client';

/**
 * Personal Telegram links (variant B of docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §4.4): no email
 * needed, so they work while the email provider is still to be chosen (D11).
 *
 * - **Invitation by link**: an administrator invites a new person with a role; the link
 *   `t.me/<bot>?start=i…` is an invitation like the email ones (same table, single use, 7 days,
 *   revocable, audited), accepted by opening it in Telegram: the sender's Telegram account becomes
 *   a person of the organization (or joins it, when already linked to someone).
 * - **Own link**: a person logged in to the dashboard links their own Telegram with
 *   `t.me/<bot>?start=l…`, single use, 30 minutes.
 *
 * Holding the link is the proof, as for any invitation link: it is random (192 bits), stored only
 * as a hash, used once and short-lived; the chat id is never in the audit, only its last digits.
 */

export const CHAT_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const OWN_LINK_TTL_MS = 30 * 60_000;
/** A start parameter: «i» invitation or «l» own link, then the token (Telegram: ≤ 64 chars). */
export const LINK_TOKEN = /^([il])([A-Za-z0-9_-]{32})$/;

export class ChatInviteError extends Error {
  readonly statusCode = 400;
  readonly code = 'CHAT_INVITE_INVALID';
  constructor(message = 'Link non valido o scaduto') {
    super(message);
    this.name = 'ChatInviteError';
  }
}

export type ChatInviteView = {
  id: string;
  role: UserRole;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  createdAt: Date;
};

export type IssuedLink = { token: string; link: string | null; expiresAt: Date };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export class ChatInviteService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    /** The bot's username, for the t.me link; without it only the token is given. */
    private readonly botUsername?: string,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private link(param: string): string | null {
    return this.botUsername ? `https://t.me/${this.botUsername}?start=${param}` : null;
  }

  /** An administrator invites a new person with a role, by a Telegram link. */
  async createInvite(
    orgId: string,
    role: UserRole,
    actor: { userId: string },
  ): Promise<IssuedLink> {
    const token = newToken();
    const expiresAt = new Date(this.now().getTime() + CHAT_INVITE_TTL_MS);
    await withTransaction(this.prisma, async (tx) => {
      const created = await tx.invitation.create({
        data: {
          orgId,
          email: CHAT_INVITE_EMAIL,
          role,
          tokenHash: sha256(`i${token}`),
          expiresAt,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await new AuditService(tx).logEvent({
        tenantId: orgId,
        userId: actor.userId,
        eventType: 'INVITATION_CREATED',
        payload: { invitationId: created.id, role, channel: 'telegram' },
      });
    });
    return { token: `i${token}`, link: this.link(`i${token}`), expiresAt };
  }

  async listInvites(orgId: string): Promise<ChatInviteView[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { orgId, email: CHAT_INVITE_EMAIL },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        role: true,
        acceptedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    const now = this.now();
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      status: r.acceptedAt
        ? 'ACCEPTED'
        : r.revokedAt
          ? 'REVOKED'
          : r.expiresAt <= now
            ? 'EXPIRED'
            : 'PENDING',
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }

  async revokeInvite(orgId: string, id: string, actor: { userId: string }): Promise<void> {
    const { count } = await this.prisma.invitation.updateMany({
      where: { id, orgId, email: CHAT_INVITE_EMAIL, acceptedAt: null, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    if (count !== 1) throw new NotFoundError('Invitation not found');
    await new AuditService(this.prisma).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: 'INVITATION_REVOKED',
      payload: { invitationId: id, channel: 'telegram' },
    });
  }

  /** A person logged in to the dashboard links their own Telegram (30 minutes, single use). */
  async createOwnLink(userId: string): Promise<IssuedLink> {
    const token = newToken();
    const expiresAt = new Date(this.now().getTime() + OWN_LINK_TTL_MS);
    await this.prisma.authChallenge.create({
      data: {
        id: randomUUID(),
        purpose: 'TELEGRAM_LINK',
        userId,
        // No chat account yet and no email: told apart from the /accedi codes.
        channelExternalId: null,
        email: null,
        codeHash: sha256(`l${token}`),
        expiresAt,
      },
    });
    return { token: `l${token}`, link: this.link(`l${token}`), expiresAt };
  }

  /**
   * Opens a link from Telegram: accepts the invitation, or links the own account. Consumed in the
   * statement that checks it, so it works once even if opened twice at the same time.
   */
  async redeem(telegramId: string, param: string): Promise<LinkResult> {
    const match = LINK_TOKEN.exec(param.trim());
    if (!match) throw new ChatInviteError();
    const externalId = telegramId.trim();
    const now = this.now();
    try {
      return await withTransaction(this.prisma, (tx) =>
        match[1] === 'i'
          ? this.acceptInvite(tx, externalId, sha256(param.trim()), now)
          : this.linkOwn(tx, externalId, sha256(param.trim()), now),
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ChatInviteError('Questo account Telegram è già collegato a un’altra persona');
      }
      throw err;
    }
  }

  private async acceptInvite(
    tx: PrismaTx,
    externalId: string,
    tokenHash: string,
    now: Date,
  ): Promise<LinkResult> {
    const invitation = await tx.invitation.findFirst({
      where: {
        tokenHash,
        email: CHAT_INVITE_EMAIL,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true, orgId: true, role: true },
    });
    if (!invitation) throw new ChatInviteError();
    const taken = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (taken.count !== 1) throw new ChatInviteError();

    const linked = await tx.channelIdentity.findFirst({
      where: { channel: 'TELEGRAM', externalId, revokedAt: null },
      select: { userId: true, user: { select: { status: true } } },
    });
    let userId: string;
    if (linked) {
      // Someone already in SinfonIA: one more membership, not a second person.
      if (linked.user.status !== 'ACTIVE') throw new ChatInviteError();
      userId = linked.userId;
      await tx.membership.upsert({
        where: { userId_orgId: { userId, orgId: invitation.orgId } },
        create: { userId, orgId: invitation.orgId, role: invitation.role, invitedBy: null },
        update: {
          role: invitation.role,
          status: 'ACTIVE',
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
          customRoleId: null,
        },
      });
    } else {
      userId = (
        await new UserRepository(tx).createUser(invitation.orgId, {
          email: `telegram-${randomUUID()}@local.invalid`,
          role: invitation.role,
        })
      ).id;
      await tx.channelIdentity.create({
        data: { userId, channel: 'TELEGRAM', externalId, verifiedAt: now, lastUsedAt: now },
      });
    }
    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedBy: userId } });
    const audit = new AuditService(tx);
    await audit.logEvent({
      tenantId: invitation.orgId,
      userId,
      eventType: 'INVITATION_ACCEPTED',
      payload: { invitationId: invitation.id, role: invitation.role, channel: 'telegram' },
    });
    if (!linked) {
      await audit.logEvent({
        tenantId: invitation.orgId,
        userId,
        eventType: 'CHANNEL_LINKED',
        payload: { channel: 'TELEGRAM', ref: shortRef(externalId), by: 'invitation' },
      });
    }
    return this.result(tx, userId);
  }

  private async linkOwn(
    tx: PrismaTx,
    externalId: string,
    codeHash: string,
    now: Date,
  ): Promise<LinkResult> {
    const consumed = await tx.$queryRaw<Array<{ user_id: string | null }>>`
      UPDATE "auth_challenge" SET "consumed_at" = ${now}
      WHERE "code_hash" = ${codeHash}
        AND "purpose" = 'TELEGRAM_LINK'
        AND "consumed_at" IS NULL
        AND "expires_at" > ${now}
        AND "channel_external_id" IS NULL
        AND "email" IS NULL
      RETURNING "user_id"`;
    const userId = consumed[0]?.user_id;
    if (!userId) throw new ChatInviteError();
    const user = await tx.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!user) throw new ChatInviteError();

    const already = await tx.channelIdentity.findFirst({
      where: { channel: 'TELEGRAM', externalId, revokedAt: null },
      select: { userId: true },
    });
    if (already && already.userId !== userId) {
      throw new ChatInviteError('Questo account Telegram è già collegato a un’altra persona');
    }
    if (!already) {
      // One Telegram per person: a new phone replaces the old link, recorded.
      await tx.channelIdentity.updateMany({
        where: { userId, channel: 'TELEGRAM', revokedAt: null },
        data: { revokedAt: now, revokedBy: userId },
      });
      await tx.channelIdentity.create({
        data: { userId, channel: 'TELEGRAM', externalId, verifiedAt: now, lastUsedAt: now },
      });
      const memberships = await tx.membership.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { orgId: true },
      });
      const audit = new AuditService(tx);
      for (const m of memberships) {
        await audit.logEvent({
          tenantId: m.orgId,
          userId,
          eventType: 'CHANNEL_LINKED',
          payload: { channel: 'TELEGRAM', ref: shortRef(externalId), by: 'own_link' },
        });
      }
    }
    return this.result(tx, userId);
  }

  private async result(tx: PrismaTx, userId: string): Promise<LinkResult> {
    const memberships = await tx.membership.findMany({
      where: { userId, status: 'ACTIVE', org: { status: 'ACTIVE' } },
      select: { orgId: true, org: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      userId,
      organizations: memberships.map((m) => ({ orgId: m.orgId, name: m.org.name })),
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return (
    code === 'P2002' ||
    (typeof message === 'string' && message.includes('channel_identity_active_key'))
  );
}
