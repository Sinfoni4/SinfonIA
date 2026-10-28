import { createHmac } from 'node:crypto';

import { DeliveryError } from '../../core/outbox/outbox.delivery.js';
import { errorLabel } from '../../shared/errors.js';

import type { WebhookEvent, WebhookNotifier } from '../../core/outbox/outbox.delivery.js';

export const SIGNATURE_HEADER = 'x-sinfonia-signature';
export const TIMESTAMP_HEADER = 'x-sinfonia-timestamp';

/**
 * HMAC-SHA256 of `<timestamp>.<body>`. Receivers recompute it with the shared secret and reject
 * stale timestamps, so a captured request cannot be replayed later.
 */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function createWebhookNotifier(options: {
  secret: string;
  // Plain http is accepted only outside production (local receivers during development).
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}): WebhookNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  return {
    async post(url: string, event: WebhookEvent) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DeliveryError('URL del webhook non valido', { permanent: true });
      }
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && options.allowInsecureHttp)
      ) {
        throw new DeliveryError('Il webhook deve usare HTTPS', { permanent: true });
      }

      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(now().getTime() / 1000));
      let response: Response;
      try {
        response = await fetchImpl(parsed, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sinfonia-event': event.eventType,
            // Stable across retries: receivers deduplicate on it.
            'x-sinfonia-delivery': event.id,
            [TIMESTAMP_HEADER]: timestamp,
            [SIGNATURE_HEADER]: signWebhookBody(options.secret, timestamp, body),
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (err: unknown) {
        throw new DeliveryError(`Webhook non raggiungibile: ${errorLabel(err)}`, {
          permanent: false,
        });
      }

      if (response.ok) return;
      const status = response.status;
      const retryable = status === 408 || status === 429 || status >= 500;
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new DeliveryError(`Webhook ha risposto ${status}`, {
        permanent: !retryable,
        ...(retryable && retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    },
  };
}
