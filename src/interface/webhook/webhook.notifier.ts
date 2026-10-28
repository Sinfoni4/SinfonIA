import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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

// Loopback, private, link-local (cloud metadata), CGNAT and unspecified ranges.
const PRIVATE_NETWORKS = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE_NETWORKS.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE_NETWORKS.addSubnet(address, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  const family = isIP(mapped);
  if (family === 0) return true;
  return PRIVATE_NETWORKS.check(mapped, family === 4 ? 'ipv4' : 'ipv6');
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
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
  // Plain http and private/loopback addresses are accepted only outside production
  // (local receivers during development).
  allowInsecureHttp?: boolean;
  allowPrivateNetwork?: boolean;
  lookup?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}): WebhookNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const lookup = options.lookup ?? defaultLookup;

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
      if (!options.allowPrivateNetwork) {
        // Blocks requests to internal services (SSRF). The check runs on the resolved addresses;
        // a DNS answer changing between this lookup and the connection is not covered.
        // IPv6 literals come as "[::1]" in URL.hostname.
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        let addresses: string[];
        try {
          addresses = isIP(host) ? [host] : await lookup(host);
        } catch (err: unknown) {
          throw new DeliveryError(`Host del webhook non risolvibile: ${errorLabel(err)}`, {
            permanent: false,
          });
        }
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
          throw new DeliveryError('Il webhook punta a un indirizzo di rete interna', {
            permanent: true,
          });
        }
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
          // Redirects are not followed: a moved endpoint must be reconfigured, not chased.
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (err: unknown) {
        throw new DeliveryError(`Webhook non raggiungibile: ${errorLabel(err)}`, {
          permanent: false,
        });
      }

      if (response.ok) return;
      const status = response.status;
      if (status >= 300 && status < 400) {
        throw new DeliveryError(
          `Webhook reindirizzato (${status}) verso ${response.headers.get('location') ?? '?'}: aggiornare l'URL`,
          { permanent: true },
        );
      }
      const retryable = status === 408 || status === 429 || status >= 500;
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new DeliveryError(`Webhook ha risposto ${status}`, {
        permanent: !retryable,
        ...(retryable && retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    },
  };
}
