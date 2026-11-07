import { createHmac, randomInt, randomUUID } from 'node:crypto';

import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { PermissionDeniedError } from '../authz/authorization.service.js';

import { acceptInvitationIn, LOGIN_CODE_TTL_MS, MAX_CODE_ATTEMPTS } from './login.service.js';

import type { PrismaTx } from '../../data/types/prisma.js';
import type { EmailSender } from '../email/email.sender.js';
import type { ChannelType, PrismaClient } from '@prisma/client';

/**
 * AGX-10 / MF7: verified linking of a chat account (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §4.4,
 * variant A). In a private chat the person writes /accedi and their email; a one-time code goes to
 * that email and is valid only when typed from the same chat account (the numeric Telegram id, or
 * the WhatsApp number). The code proves the mailbox, the chat proves the account: together they
 * link the chat to the person, accepting at the same time the invitations waiting for that email.
 * The permanent invite code of an organization no longer links anyone.
 *
 * - Codes: 6 digits, 10 minutes, stored as an HMAC, bound to the purpose `TELEGRAM_LINK` (used by
 *   both chats), to the chat account and to the email; at most 5 attempts; consumed in the same
 *   statement that checks them, so two concurrent attempts cannot both link.
 * - Starting answers the same way for any email (no code is sent when nothing waits for it).
 * - A chat account has at most one active link (unique index): a second one rolls back.
 * - Links are listed and revoked by the person (chat or dashboard) and by an administrator for the
 *   members of the organization; every link and revocation is in the audit, with the chat id
 *   shortened.
 */

export const MAX_LINK_CODES_PER_HOUR = 5;

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ChannelLinkError extends Error {
  readonly statusCode = 400;
  readonly code = 'CHANNEL_LINK_FAILED';
  constructor(message = 'Codice non valido o scaduto') {
    super(message);
    this.name = 'ChannelLinkError';
  }
}

export type ChannelLink = {
  id: string;
  channel: ChannelType;
  /** The chat id shortened (last digits), never the whole number. */
  ref: string;
  linkedAt: string;
  verified: boolean;
  lastUsedAt: string | null;
};

export type LinkResult = {
  userId: string;
  organizations: Array<{ orgId: string; name: string }>;
};

type Log = { warn: (obj: unknown, msg?: string) => void };

/** The last 3 characters of a chat id, for the audit and the lists. */
export function shortRef(externalId: string): string {
  const id = externalId.trim();
  return `…${id.slice(-3)}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const CHANNEL_NAMES: Record<ChannelType, string> = {
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
};

export class ChannelLinkService {
  private readonly now: () => Date;
  private readonly exposeCodes: boolean;
  private readonly log?: Log;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly email: EmailSender,
    private readonly secret: string,
    options: { now?: () => Date; exposeCodes?: boolean; log?: Log } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.exposeCodes = options.exposeCodes ?? false;
    this.log = options.log;
  }

  private codeHash(challengeId: string, code: string): string {
    return createHmac('sha256', this.secret).update(`link:${challengeId}:${code}`).digest('hex');
  }

  private chatKey(channel: ChannelType, externalId: string): string {
    return `${channel}:${externalId.trim()}`;
  }

  /** Whether this chat account is already linked to an active person. */
  async isLinked(channel: ChannelType, externalId: string): Promise<boolean> {
    return (
      (await this.prisma.channelIdentity.count({
        where: { channel, externalId: externalId.trim(), revokedAt: null },
      })) > 0
    );
  }

  /** What waits for this email: an active account, and/or valid invitations. */
  private async targetsOf(email: string) {
    const now = this.now();
    const [users, invitations] = await Promise.all([
      this.prisma.user.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
        select: { id: true },
        take: 2,
      }),
      this.prisma.invitation.findMany({
        where: {
          email: { equals: email, mode: 'insensitive' },
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      }),
    ]);
    // An email shared by several legacy accounts never links (D8: no automatic merge).
    if (users.length > 1) return null;
    if (users.length === 0 && invitations.length === 0) return null;
    return { userId: users[0]?.id ?? null };
  }

  /**
   * Starts a link from a chat. The answer has the same shape for any email; a code is sent only
   * when an account or an invitation waits for it, and the codes per email and per chat account
   * are limited per hour.
   */
  async start(input: {
    channel: ChannelType;
    externalId: string;
    email: string;
  }): Promise<{ challengeId: string; devCode?: string }> {
    const email = normalizeEmail(input.email);
    if (!EMAIL.test(email) || PLACEHOLDER_EMAIL.test(email)) {
      throw new ChannelLinkError('Email non valida');
    }
    if (await this.isLinked(input.channel, input.externalId)) {
      throw new ChannelLinkError('Questo account è già collegato');
    }
    const key = this.chatKey(input.channel, input.externalId);
    const hourAgo = new Date(this.now().getTime() - 60 * 60_000);
    const [perEmail, perChat] = await Promise.all([
      this.prisma.authChallenge.count({
        where: { purpose: 'TELEGRAM_LINK', email, createdAt: { gt: hourAgo } },
      }),
      this.prisma.authChallenge.count({
        where: { purpose: 'TELEGRAM_LINK', channelExternalId: key, createdAt: { gt: hourAgo } },
      }),
    ]);
    const target = await this.targetsOf(email);
    const id = randomUUID();
    if (!target || perEmail >= MAX_LINK_CODES_PER_HOUR || perChat >= MAX_LINK_CODES_PER_HOUR) {
      if (target) this.log?.warn({ channel: input.channel }, 'Link codes per hour exceeded');
      // Same answer: an id that matches no challenge.
      return { challengeId: id };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.authChallenge.create({
      data: {
        id,
        purpose: 'TELEGRAM_LINK',
        email,
        userId: target.userId,
        channelExternalId: key,
        codeHash: this.codeHash(id, code),
        expiresAt: new Date(this.now().getTime() + LOGIN_CODE_TTL_MS),
      },
    });
    const name = CHANNEL_NAMES[input.channel];
    await this.email.send({
      to: email,
      subject: `Il codice per collegare ${name} a SinfonIA`,
      text:
        `Il codice per collegare il tuo account ${name} è ${code}.\n` +
        `Scrivilo nella stessa chat da cui l'hai chiesto: vale 10 minuti e una sola volta.\n` +
        'Se non sei stato tu, ignora questo messaggio: senza il codice non succede nulla.',
    });
    return this.exposeCodes ? { challengeId: id, devCode: code } : { challengeId: id };
  }

  /**
   * Checks the code from the same chat account and links it, in one transaction: the challenge is
   * consumed by the statement that checks purpose, expiry, attempts, chat account and code; the
   * invitations waiting for the email are accepted; the chat account is linked (a second active
   * link of the same account violates the unique index and rolls everything back).
   */
  async verify(input: {
    channel: ChannelType;
    externalId: string;
    challengeId: string;
    code: string;
  }): Promise<LinkResult> {
    const code = input.code.trim();
    if (!/^[0-9a-f-]{36}$/i.test(input.challengeId) || !/^\d{6}$/.test(code)) {
      throw new ChannelLinkError();
    }
    const key = this.chatKey(input.channel, input.externalId);
    const now = this.now();
    let result: LinkResult;
    try {
      result = await withTransaction(this.prisma, async (tx) => {
        const consumed = await tx.$queryRaw<Array<{ email: string | null }>>`
          UPDATE "auth_challenge" SET "consumed_at" = ${now}, "attempts" = "attempts" + 1
          WHERE "id" = ${input.challengeId}::uuid
            AND "purpose" = 'TELEGRAM_LINK'
            AND "consumed_at" IS NULL
            AND "expires_at" > ${now}
            AND "attempts" < ${MAX_CODE_ATTEMPTS}
            AND "channel_external_id" = ${key}
            AND "code_hash" = ${this.codeHash(input.challengeId, code)}
          RETURNING "email"`;
        const email = consumed[0]?.email;
        if (!email) throw new ChannelLinkError();
        return this.link(tx, input.channel, input.externalId, email, now);
      });
    } catch (err: unknown) {
      if (err instanceof ChannelLinkError) {
        // A wrong attempt counts, in its own statement, on the challenge of this chat only.
        await this.prisma.authChallenge.updateMany({
          where: {
            id: /^[0-9a-f-]{36}$/i.test(input.challengeId) ? input.challengeId : randomUUID(),
            purpose: 'TELEGRAM_LINK',
            consumedAt: null,
            channelExternalId: key,
          },
          data: { attempts: { increment: 1 } },
        });
      }
      if (isUniqueViolation(err)) throw new ChannelLinkError('Questo account è già collegato');
      throw err;
    }

    const first = await this.prisma.user.findUnique({
      where: { id: result.userId },
      select: { email: true },
    });
    if (first?.email && !PLACEHOLDER_EMAIL.test(first.email)) {
      const name = CHANNEL_NAMES[input.channel];
      await this.email
        .send({
          to: first.email,
          subject: `${name} collegato a SinfonIA`,
          text:
            `Il tuo account ${name} (${shortRef(input.externalId)}) è ora collegato a SinfonIA.\n` +
            `Se non sei stato tu, scrivi /scollega nella chat o revoca il collegamento dal tuo ` +
            'profilo nella dashboard, e avvisa l’amministratore della tua organizzazione.',
        })
        .catch(() => undefined);
    }
    return result;
  }

  private async link(
    tx: PrismaTx,
    channel: ChannelType,
    externalId: string,
    email: string,
    now: Date,
  ): Promise<LinkResult> {
    // The invitations waiting for this email: the code proved it, as the web acceptance does.
    const invitations = await tx.invitation.findMany({
      where: {
        email: { equals: email, mode: 'insensitive' },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true, orgId: true, email: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    let userId: string | null = null;
    for (const invitation of invitations) {
      userId = await acceptInvitationIn(tx, invitation, now);
    }
    if (!userId) {
      const users = await tx.user.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
        select: { id: true },
        take: 2,
      });
      if (users.length !== 1) throw new ChannelLinkError();
      userId = users[0].id;
    }
    await tx.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });

    // A person has one active link per chat: a new phone replaces the old one, recorded.
    const previous = await tx.channelIdentity.findMany({
      where: { userId, channel, revokedAt: null },
      select: { id: true, externalId: true },
    });
    if (previous.length > 0) {
      await tx.channelIdentity.updateMany({
        where: { id: { in: previous.map((p) => p.id) } },
        data: { revokedAt: now, revokedBy: userId },
      });
    }
    await tx.channelIdentity.create({
      data: { userId, channel, externalId: externalId.trim(), verifiedAt: now, lastUsedAt: now },
    });

    const memberships = await tx.membership.findMany({
      where: { userId, status: 'ACTIVE', org: { status: 'ACTIVE' } },
      select: { orgId: true, org: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const audit = new AuditService(tx);
    for (const m of memberships) {
      for (const p of previous) {
        await audit.logEvent({
          tenantId: m.orgId,
          userId,
          eventType: 'CHANNEL_UNLINKED',
          payload: { channel, ref: shortRef(p.externalId), by: 'replaced' },
        });
      }
      await audit.logEvent({
        tenantId: m.orgId,
        userId,
        eventType: 'CHANNEL_LINKED',
        payload: { channel, ref: shortRef(externalId) },
      });
    }
    return {
      userId,
      organizations: memberships.map((m) => ({ orgId: m.orgId, name: m.org.name })),
    };
  }

  /** The active links of a person. */
  async list(userId: string): Promise<ChannelLink[]> {
    const rows = await this.prisma.channelIdentity.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        channel: true,
        externalId: true,
        createdAt: true,
        verifiedAt: true,
        lastUsedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      ref: shortRef(r.externalId),
      linkedAt: r.createdAt.toISOString(),
      verified: r.verifiedAt !== null,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Revokes a link: by the person (`actor.userId` is the owner) or by an administrator of an
   * organization the owner is a member of (`actor.orgId`, checked by the caller's permission).
   * The bot stops recognizing the chat account at once.
   */
  async revoke(input: {
    identityId: string;
    ownerUserId: string;
    actor: { userId: string; orgId?: string };
    channelHint?: string;
  }): Promise<void> {
    const byAdmin = input.actor.userId !== input.ownerUserId;
    if (byAdmin) {
      if (!input.actor.orgId) throw new PermissionDeniedError('members.manage');
      const member = await this.prisma.membership.count({
        where: { userId: input.ownerUserId, orgId: input.actor.orgId },
      });
      if (member === 0) throw new NotFoundError('Link not found');
    }
    await withTransaction(this.prisma, async (tx) => {
      const identity = await tx.channelIdentity.findFirst({
        where: { id: input.identityId, userId: input.ownerUserId, revokedAt: null },
        select: { id: true, channel: true, externalId: true },
      });
      if (!identity) throw new NotFoundError('Link not found');
      await tx.channelIdentity.update({
        where: { id: identity.id },
        data: { revokedAt: this.now(), revokedBy: input.actor.userId },
      });
      const memberships = await tx.membership.findMany({
        where: { userId: input.ownerUserId },
        select: { orgId: true },
      });
      const audit = new AuditService(tx);
      for (const m of memberships) {
        await audit.logEvent({
          tenantId: m.orgId,
          userId: input.actor.userId,
          eventType: 'CHANNEL_UNLINKED',
          payload: {
            channel: identity.channel,
            ref: shortRef(identity.externalId),
            by: byAdmin ? 'admin' : 'person',
            ...(byAdmin ? { targetUserId: input.ownerUserId } : {}),
            ...(input.channelHint ? { action: input.channelHint } : {}),
          },
        });
      }
    });
  }

  /** The person's own revocation from the chat they are writing from. */
  async revokeFromChat(channel: ChannelType, externalId: string): Promise<boolean> {
    const identity = await this.prisma.channelIdentity.findFirst({
      where: { channel, externalId: externalId.trim(), revokedAt: null },
      select: { id: true, userId: true },
    });
    if (!identity) return false;
    await this.revoke({
      identityId: identity.id,
      ownerUserId: identity.userId,
      actor: { userId: identity.userId },
      channelHint: 'chat',
    });
    return true;
  }

  /** The links of the person writing from this chat account, or null when it is not linked. */
  async listFromChat(channel: ChannelType, externalId: string): Promise<ChannelLink[] | null> {
    const identity = await this.prisma.channelIdentity.findFirst({
      where: { channel, externalId: externalId.trim(), revokedAt: null },
      select: { userId: true },
    });
    return identity ? this.list(identity.userId) : null;
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
