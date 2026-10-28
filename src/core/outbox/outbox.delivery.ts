import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';

/**
 * A delivery failure. `permanent` failures (unknown chat, bot blocked, 4xx from a webhook) are not
 * retried; the others are retried with exponential backoff, or after `retryAfterMs` when the
 * receiver asks for it.
 */
export class DeliveryError extends Error {
  readonly permanent: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { permanent: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'DeliveryError';
    this.permanent = options.permanent;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/** One recipient of a message. `target` is stable across retries, so delivered targets are skipped. */
export type OutboxDelivery = {
  target: string;
  send: () => Promise<void>;
};

export interface OutboxEventHandler {
  readonly eventType: string;
  resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]>;
}

export type OutboxDocument = {
  filename: string;
  content: Buffer;
  mimeType: string;
};

export interface TelegramNotifier {
  sendDocument(chatId: string, document: OutboxDocument, caption: string): Promise<void>;
}

export type WebhookEvent = {
  id: string;
  eventType: string;
  tenantId: string;
  createdAt: string;
  data: unknown;
};

export interface WebhookNotifier {
  post(url: string, event: WebhookEvent): Promise<void>;
}
