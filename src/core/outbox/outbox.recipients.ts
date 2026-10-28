import { DeliveryError } from './outbox.delivery.js';

import type { OutboxDelivery, TelegramNotifier, WebhookNotifier } from './outbox.delivery.js';
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
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      telegramId: { not: null },
      OR: [{ role: 'ADMIN' }, ...(extraUserIds.length ? [{ id: { in: extraUserIds } }] : [])],
    },
    orderBy: { createdAt: 'asc' },
    select: { telegramId: true },
  });
  const chatIds = [...new Set(users.map((u) => u.telegramId!))];

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
