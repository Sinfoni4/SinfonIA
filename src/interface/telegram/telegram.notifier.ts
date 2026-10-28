import { DeliveryError } from '../../core/outbox/outbox.delivery.js';

import { TelegramApiError } from './telegram.client.js';

import type { TelegramClient } from './telegram.client.js';
import type { OutboxDocument, TelegramNotifier } from '../../core/outbox/outbox.delivery.js';

/**
 * Maps Bot API failures to delivery errors: 429 waits for `retry_after`, 400/403/404 (chat not
 * found, bot blocked by the user) are permanent, everything else (5xx, network) is retried.
 */
export function toDeliveryError(err: unknown): unknown {
  if (!(err instanceof TelegramApiError)) {
    return err;
  }
  if (err.errorCode === 429) {
    return new DeliveryError(err.message, {
      permanent: false,
      ...(err.retryAfterSeconds !== undefined
        ? { retryAfterMs: err.retryAfterSeconds * 1000 }
        : {}),
    });
  }
  return new DeliveryError(err.message, {
    permanent: err.errorCode === 400 || err.errorCode === 403 || err.errorCode === 404,
  });
}

export function createTelegramNotifier(
  client: Pick<TelegramClient, 'sendDocument'>,
): TelegramNotifier {
  return {
    async sendDocument(chatId: string, document: OutboxDocument, caption: string) {
      try {
        await client.sendDocument(chatId, document, { caption });
      } catch (err: unknown) {
        throw toDeliveryError(err);
      }
    },
  };
}
