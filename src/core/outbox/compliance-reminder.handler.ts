import { formatReminderMessage } from '../compliance/compliance.messages.js';
import { COMPLIANCE_DEADLINE_REMINDER } from '../compliance/compliance.service.js';

import { chatDeliveries, webhookDeliveries } from './outbox.recipients.js';

import type { OutboxChannels, OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';
import type { ComplianceReminderPayload } from '../compliance/compliance.service.js';

/**
 * Deadline reminders go on Telegram to the tenant ADMINs and to the member the deadline refers
 * to, and to the tenant webhook if one is configured.
 */
export class ComplianceReminderHandler implements OutboxEventHandler {
  readonly eventType = COMPLIANCE_DEADLINE_REMINDER;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as ComplianceReminderPayload;
    const text = formatReminderMessage(payload);

    return [
      ...(await chatDeliveries(
        this.prisma,
        message.tenantId,
        this.channels,
        (telegram, chatId) => telegram.sendMessage(chatId, text),
        payload.userId ? [payload.userId] : [],
      )),
      ...(await webhookDeliveries(this.prisma, message, this.channels.webhook, payload)),
    ];
  }
}
