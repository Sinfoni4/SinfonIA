import { DeliveryError } from '../../core/outbox/outbox.delivery.js';

import { WhatsAppApiError } from './whatsapp.client.js';

import type { WhatsAppClient } from './whatsapp.client.js';
import type { ChatNotifier, OutboxDocument } from '../../core/outbox/outbox.delivery.js';

// Meta error codes (WhatsApp Cloud API).
const OUTSIDE_24H_WINDOW = 131047;
const RATE_LIMITS = new Set([4, 80007, 130429, 131048, 131056]);

/**
 * Maps Cloud API failures to delivery errors. Outside the 24-hour customer service window Meta
 * only accepts approved template messages: that is permanent until templates are configured.
 * Rate limits and 5xx are retried; other 4xx (invalid number, unsupported) are permanent.
 */
export function toWhatsAppDeliveryError(err: unknown): unknown {
  if (!(err instanceof WhatsAppApiError)) {
    return err;
  }
  if (err.code === OUTSIDE_24H_WINDOW) {
    return new DeliveryError(
      `${err.message} — fuori dalla finestra di 24 ore: serve un template approvato da Meta`,
      { permanent: true },
    );
  }
  if (
    (err.code !== undefined && RATE_LIMITS.has(err.code)) ||
    err.status === 429 ||
    err.status >= 500
  ) {
    return new DeliveryError(err.message, { permanent: false });
  }
  return new DeliveryError(err.message, { permanent: err.status >= 400 && err.status < 500 });
}

export function createWhatsAppNotifier(
  client: Pick<WhatsAppClient, 'sendText' | 'sendDocument'>,
): ChatNotifier {
  return {
    async sendDocument(phone: string, document: OutboxDocument, caption: string) {
      try {
        await client.sendDocument(phone, document, caption);
      } catch (err: unknown) {
        throw toWhatsAppDeliveryError(err);
      }
    },
    async sendMessage(phone: string, text: string) {
      try {
        await client.sendText(phone, text);
      } catch (err: unknown) {
        throw toWhatsAppDeliveryError(err);
      }
    },
  };
}
