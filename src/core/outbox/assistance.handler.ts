import {
  ASSISTANCE_REQUESTED,
  ASSISTANCE_UPDATED,
  TOPIC_LABELS,
} from '../assistance/assistance.service.js';

import { chatDeliveriesTo } from './outbox.recipients.js';

import type { OutboxChannels, OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';
import type {
  AssistanceRequestedPayload,
  AssistanceUpdatedPayload,
} from '../assistance/assistance.service.js';

/**
 * A new request goes in chat to the ADMINs and OPERATORs of the organization. The notice names
 * only the topic: who asked is seen in the dashboard, not left in the chat history of everyone.
 * A request handled in the meantime sends nothing.
 */
export class AssistanceRequestedHandler implements OutboxEventHandler {
  readonly eventType = ASSISTANCE_REQUESTED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
    /** Dashboard page of the requests, when the public address is known. */
    private readonly assistanceUrl?: string,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const { requestId } = message.payload as AssistanceRequestedPayload;
    const request = await this.prisma.assistanceRequest.findFirst({
      where: { id: requestId, tenantId: message.tenantId, status: 'OPEN' },
      select: { topic: true },
    });
    if (!request) return [];
    const text =
      `🙋 Nuova richiesta di assistenza su ${TOPIC_LABELS[request.topic]}.\n` +
      (this.assistanceUrl
        ? `Gestiscila dalla dashboard: ${this.assistanceUrl}`
        : 'Gestiscila dalla dashboard, nella pagina «Assistenza».');
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { roles: ['ADMIN', 'OPERATOR'] },
    );
  }
}

/** The person who asked hears in chat that the request was taken in charge, or closed. */
export class AssistanceUpdatedHandler implements OutboxEventHandler {
  readonly eventType = ASSISTANCE_UPDATED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as AssistanceUpdatedPayload;
    const text =
      payload.action === 'take'
        ? '📞 Un operatore ha preso in carico la tua richiesta di assistenza: ti contatterà a breve.'
        : '✅ La tua richiesta di assistenza è stata chiusa. Se ti serve ancora aiuto scrivi «operatore».';
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}
