import {
  auditExportDelivery,
  scheduledExportDeliveries,
  webhookDeliveries,
} from './outbox.recipients.js';

import type { OutboxChannels, OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
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
 * Scheduled practice exports go, as a CSV file in chat, only to the ADMINs who chose to receive
 * them (D5b option b), and to the tenant webhook, if one is configured. Every delivery is audited.
 */
export class PracticeExportHandler implements OutboxEventHandler {
  readonly eventType = PRACTICE_EXPORT_GENERATED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = (message.payload ?? {}) as ExportPayload;
    const document = {
      filename: exportFilename(payload, message.createdAt),
      content: Buffer.from(payload.csv ?? '', 'utf-8'),
      mimeType: 'text/csv',
    };
    const caption = `📊 ${payload.title ?? 'Export pratiche'}\nPratiche incluse: ${payload.practiceCount ?? 0}`;

    // Telegram rejects empty files ("file must be non-empty"): with no practices, say so in text.
    const hasRows = (payload.csv ?? '').length > 0;

    const rows = payload.practiceCount ?? 0;
    const webhook = await webhookDeliveries(this.prisma, message, this.channels.webhook, payload);
    return [
      ...(await scheduledExportDeliveries(
        this.prisma,
        message,
        this.channels,
        (notifier, chatId) =>
          hasRows
            ? notifier.sendDocument(chatId, document, caption)
            : notifier.sendMessage(chatId, `${caption}\nNessuna pratica nel periodo.`),
        rows,
      )),
      ...webhook.map((delivery) =>
        delivery.target === 'webhook'
          ? {
              ...delivery,
              send: async () => {
                await delivery.send();
                await auditExportDelivery(this.prisma, message, { channel: 'webhook', rows });
              },
            }
          : delivery,
      ),
    ];
  }
}
