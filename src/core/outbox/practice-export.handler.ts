import { DeliveryError } from './outbox.delivery.js';

import type {
  OutboxDelivery,
  OutboxEventHandler,
  TelegramNotifier,
  WebhookNotifier,
} from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';

export const PRACTICE_EXPORT_GENERATED = 'PRACTICE_EXPORT_GENERATED';

type ExportPayload = {
  title?: string;
  csv?: string;
  practiceCount?: number;
  generatedAt?: string;
};

function exportFilename(payload: ExportPayload, createdAt: Date): string {
  const date = (payload.generatedAt ?? createdAt.toISOString()).slice(0, 10);
  return `export-pratiche-${date}.csv`;
}

/**
 * Scheduled practice exports go to every tenant ADMIN linked to Telegram (as a CSV file) and to the
 * tenant webhook, if one is configured.
 */
export class PracticeExportHandler implements OutboxEventHandler {
  readonly eventType = PRACTICE_EXPORT_GENERATED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: { telegram?: TelegramNotifier; webhook?: WebhookNotifier },
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = (message.payload ?? {}) as ExportPayload;
    const deliveries: OutboxDelivery[] = [];

    const telegram = this.channels.telegram;
    const admins = await this.prisma.user.findMany({
      where: { tenantId: message.tenantId, role: 'ADMIN', telegramId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { telegramId: true },
    });
    if (!telegram) {
      // Bot not configured in this process (e.g. token missing during a deploy): keep the
      // recipients and retry, instead of dead-lettering the export as having none.
      for (const { telegramId } of admins) {
        deliveries.push({
          target: `telegram:${telegramId!}`,
          send: () =>
            Promise.reject(
              new DeliveryError('Bot Telegram non configurato (TELEGRAM_BOT_TOKEN)', {
                permanent: false,
              }),
            ),
        });
      }
    } else {
      const document = {
        filename: exportFilename(payload, message.createdAt),
        content: Buffer.from(payload.csv ?? '', 'utf-8'),
        mimeType: 'text/csv',
      };
      const caption = `📊 ${payload.title ?? 'Export pratiche'}\nPratiche incluse: ${payload.practiceCount ?? 0}`;
      for (const { telegramId } of admins) {
        const chatId = telegramId!;
        deliveries.push({
          target: `telegram:${chatId}`,
          send: () => telegram.sendDocument(chatId, document, caption),
        });
      }
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: message.tenantId },
      select: { webhookUrl: true },
    });
    const webhookUrl = tenant?.webhookUrl?.trim();
    if (webhookUrl) {
      const webhook = this.channels.webhook;
      deliveries.push({
        target: 'webhook',
        send: webhook
          ? () =>
              webhook.post(webhookUrl, {
                id: message.id,
                eventType: message.eventType,
                tenantId: message.tenantId,
                createdAt: message.createdAt.toISOString(),
                data: payload,
              })
          : // A configured endpoint must not be skipped silently: dead-letter until the secret is set.
            () =>
              Promise.reject(
                new DeliveryError('Webhook non configurato: manca OUTBOX_WEBHOOK_SECRET', {
                  permanent: true,
                }),
              ),
      });
    }

    return deliveries;
  }
}
