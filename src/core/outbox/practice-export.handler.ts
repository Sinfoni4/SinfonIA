import { chatDeliveries, webhookDeliveries } from './outbox.recipients.js';

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
 * Scheduled practice exports go to every tenant ADMIN linked to Telegram (as a CSV file) and to the
 * tenant webhook, if one is configured.
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

    return [
      ...(await chatDeliveries(this.prisma, message.tenantId, this.channels, (telegram, chatId) =>
        hasRows
          ? telegram.sendDocument(chatId, document, caption)
          : telegram.sendMessage(chatId, `${caption}\nNessuna pratica nel periodo.`),
      )),
      ...(await webhookDeliveries(this.prisma, message, this.channels.webhook, payload)),
    ];
  }
}
