import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { chatDeliveries } from '../outbox/outbox.recipients.js';

import { daysLeft } from './delegation.service.js';

import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';
import type {
  OutboxChannels,
  OutboxDelivery,
  OutboxEventHandler,
} from '../outbox/outbox.delivery.js';
import type { SchedulerTaskContext, SchedulerTaskHandler } from '../scheduler/scheduler.tasks.js';
import type { PrismaClient } from '@prisma/client';

/** D3.4: the grantor is told 30 and 7 days before a delegation ends. */
export const GRANT_EXPIRING = 'GRANT_EXPIRING';

export type GrantExpiringPayload = { grantId: string; validUntil: string };

const DAY_MS = 24 * 60 * 60_000;

/**
 * Daily task of every organization: queues the reminders of its delegations that end within 30
 * or 7 days, once per validity (a renewal clears the marks).
 */
export class GrantExpiryTask implements SchedulerTaskHandler {
  readonly type = 'CHECK_GRANT_EXPIRY' as const;

  constructor(private readonly prisma: PrismaClient) {}

  async run({ tenant, now }: SchedulerTaskContext): Promise<Record<string, unknown>> {
    const grants = await this.prisma.accessGrant.findMany({
      where: {
        grantorOrgId: tenant.id,
        status: 'ACTIVE',
        validUntil: { gt: now, lte: new Date(now.getTime() + 30 * DAY_MS) },
        OR: [{ reminded30At: null }, { reminded7At: null }],
      },
      select: { id: true, validUntil: true, reminded30At: true, reminded7At: true },
    });
    let enqueued = 0;
    for (const g of grants) {
      const within7 = g.validUntil.getTime() - now.getTime() <= 7 * DAY_MS;
      const due = within7 ? g.reminded7At === null : g.reminded30At === null;
      if (!due) continue;
      await withTransaction(this.prisma, async (tx) => {
        // Conditional: two schedulers at once enqueue it only once.
        const marked = await tx.accessGrant.updateMany({
          where: within7 ? { id: g.id, reminded7At: null } : { id: g.id, reminded30At: null },
          data: within7
            ? { reminded7At: now, reminded30At: g.reminded30At ?? now }
            : { reminded30At: now },
        });
        if (marked.count === 0) return;
        await new OutboxRepository(tx).createMessage({
          tenantId: tenant.id,
          eventType: GRANT_EXPIRING,
          payload: {
            grantId: g.id,
            validUntil: g.validUntil.toISOString(),
          } satisfies GrantExpiringPayload,
        });
        enqueued++;
      });
    }
    return { checked: grants.length, enqueued };
  }
}

/**
 * Sends the reminder in chat to the administrators of the grantor, with who receives the
 * delegation and its beneficiaries. Nothing is sent if it was renewed or revoked meanwhile.
 * (By email too once the email provider is chosen, D11.)
 */
export class GrantExpiringHandler implements OutboxEventHandler {
  readonly eventType = GRANT_EXPIRING;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
    /** Dashboard page of the delegations, when the address is known. */
    private readonly grantsUrl?: string,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as GrantExpiringPayload;
    const grant = await this.prisma.accessGrant.findFirst({
      where: {
        id: payload.grantId,
        grantorOrgId: message.tenantId,
        status: 'ACTIVE',
        validUntil: new Date(payload.validUntil),
      },
      select: {
        validUntil: true,
        granteeOrg: { select: { name: true } },
        granteeUser: { select: { email: true } },
        beneficiaries: {
          where: { status: 'ACTIVE' },
          select: { user: { select: { email: true } } },
        },
      },
    });
    if (!grant) return [];
    const now = new Date();
    if (grant.validUntil <= now) return [];
    const who = grant.granteeOrg?.name ?? grant.granteeUser?.email ?? 'una persona';
    const people = grant.beneficiaries
      .map((b) => b.user.email)
      .filter((e) => !e.endsWith('@local.invalid'));
    const day = grant.validUntil.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
    const text =
      `⏳ La delega a «${who}» scade il ${day} (tra ${daysLeft(grant.validUntil, now)} giorni).` +
      (people.length ? `\nBeneficiari: ${people.join(', ')}.` : '') +
      '\nSe serve ancora, rinnovala; altrimenti lasciala scadere.' +
      (this.grantsUrl ? `\n${this.grantsUrl}` : '');
    return chatDeliveries(this.prisma, message.tenantId, this.channels, (notifier, chatId) =>
      notifier.sendMessage(chatId, text),
    );
  }
}
