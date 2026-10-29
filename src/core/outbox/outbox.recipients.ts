import { chatRecipients } from '../identity/membership.service.js';

import { DeliveryError } from './outbox.delivery.js';

import type {
  ChatNotifier,
  OutboxChannels,
  OutboxDelivery,
  TelegramNotifier,
  WebhookNotifier,
} from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';

/**
 * Telegram chats of the tenant ADMINs plus the given extra users (e.g. the member a deadline
 * refers to), each chat once, as stable `telegram:<chatId>` targets.
 */
export async function telegramDeliveries(
  prisma: PrismaLike,
  tenantId: string,
  telegram: TelegramNotifier | undefined,
  send: (telegram: TelegramNotifier, chatId: string) => Promise<void>,
  extraUserIds: string[] = [],
): Promise<OutboxDelivery[]> {
  // Active ADMINs (and extra users) with an active Telegram link, checked at delivery time.
  const chatIds = await chatRecipients(prisma, tenantId, 'TELEGRAM', extraUserIds);

  return chatIds.map((chatId) => ({
    target: `telegram:${chatId}`,
    send: telegram
      ? () => send(telegram, chatId)
      : // Bot not configured in this process (e.g. token missing during a deploy): keep the
        // recipients and retry, instead of dead-lettering the message as having none.
        () =>
          Promise.reject(
            new DeliveryError('Bot Telegram non configurato (TELEGRAM_BOT_TOKEN)', {
              permanent: false,
            }),
          ),
  }));
}

/** Deliveries through a chat channel; when the channel is not configured they are retried. */
function chatTargets(
  prefix: string,
  ids: string[],
  notifier: ChatNotifier | undefined,
  send: (notifier: ChatNotifier, chatId: string) => Promise<void>,
  missing: string,
): OutboxDelivery[] {
  return [...new Set(ids)].map((chatId) => ({
    target: `${prefix}:${chatId}`,
    send: notifier
      ? () => send(notifier, chatId)
      : () => Promise.reject(new DeliveryError(missing, { permanent: false })),
  }));
}

/**
 * WhatsApp numbers of the tenant ADMINs plus the given extra users, as `whatsapp:<phone>` targets.
 */
export async function whatsappDeliveries(
  prisma: PrismaLike,
  tenantId: string,
  whatsapp: ChatNotifier | undefined,
  send: (notifier: ChatNotifier, phone: string) => Promise<void>,
  extraUserIds: string[] = [],
): Promise<OutboxDelivery[]> {
  const phones = await chatRecipients(prisma, tenantId, 'WHATSAPP', extraUserIds);
  return chatTargets(
    'whatsapp',
    phones,
    whatsapp,
    send,
    'WhatsApp non configurato (WHATSAPP_ACCESS_TOKEN)',
  );
}

/** Telegram and WhatsApp deliveries of the same content to the same recipients. */
export async function chatDeliveries(
  prisma: PrismaLike,
  tenantId: string,
  channels: OutboxChannels,
  send: (notifier: ChatNotifier, chatId: string) => Promise<void>,
  extraUserIds: string[] = [],
): Promise<OutboxDelivery[]> {
  return [
    ...(await telegramDeliveries(prisma, tenantId, channels.telegram, send, extraUserIds)),
    ...(await whatsappDeliveries(prisma, tenantId, channels.whatsapp, send, extraUserIds)),
  ];
}

/** The tenant webhook, when one is configured, as the `webhook` target. */
export async function webhookDeliveries(
  prisma: PrismaLike,
  message: ClaimedOutboxMessage,
  webhook: WebhookNotifier | undefined,
  data: unknown,
): Promise<OutboxDelivery[]> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: message.tenantId },
    select: { webhookUrl: true },
  });
  const webhookUrl = tenant?.webhookUrl?.trim();
  if (!webhookUrl) return [];

  return [
    {
      target: 'webhook',
      send: webhook
        ? () =>
            webhook.post(webhookUrl, {
              id: message.id,
              eventType: message.eventType,
              tenantId: message.tenantId,
              createdAt: message.createdAt.toISOString(),
              data,
            })
        : // A configured endpoint must not be skipped silently: dead-letter until the secret is set.
          () =>
            Promise.reject(
              new DeliveryError('Webhook non configurato: manca OUTBOX_WEBHOOK_SECRET', {
                permanent: true,
              }),
            ),
    },
  ];
}
