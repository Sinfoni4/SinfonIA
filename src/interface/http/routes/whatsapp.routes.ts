import { errorLabel } from '../../../shared/errors.js';
import { verifyWebhookSignature } from '../../whatsapp/whatsapp.channel.js';

import type { FastifyPluginCallback } from 'fastify';

export const WHATSAPP_WEBHOOK_PATH = '/webhooks/whatsapp';

export type WhatsAppRoutesOptions = {
  /** Token set in the Meta app dashboard for the subscription handshake. */
  verifyToken: string;
  /** App secret: Meta signs every delivery with it. */
  appSecret: string;
  /** Handles a verified payload; runs after the 200 reply, as Meta expects a fast answer. */
  onPayload: (payload: unknown) => Promise<void>;
};

/**
 * WhatsApp Cloud API webhook. Public route (no JWT): requests are authenticated by Meta's
 * signature instead. Registered in its own encapsulated context so the raw-body JSON parser it
 * needs does not affect the other routes.
 */
export const whatsappRoutes: FastifyPluginCallback<WhatsAppRoutesOptions> = (
  app,
  options,
  done,
) => {
  // The signature covers the exact bytes Meta sent: keep the body raw and parse it after checking.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, next) => {
    next(null, body);
  });

  // Subscription handshake: Meta calls with hub.mode=subscribe and expects hub.challenge back.
  app.get(WHATSAPP_WEBHOOK_PATH, async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === options.verifyToken) {
      return reply.type('text/plain').send(query['hub.challenge'] ?? '');
    }
    return reply.status(403).send({ ok: false });
  });

  app.post(WHATSAPP_WEBHOOK_PATH, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.headers['x-hub-signature-256'];
    if (
      !verifyWebhookSignature(
        raw,
        typeof signature === 'string' ? signature : undefined,
        options.appSecret,
      )
    ) {
      req.log.warn('Rejected WhatsApp webhook with an invalid signature');
      return reply.status(401).send({ ok: false });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf-8'));
    } catch {
      return reply.status(400).send({ ok: false });
    }

    void options.onPayload(payload).catch((err: unknown) => {
      req.log.error({ error: errorLabel(err) }, 'WhatsApp webhook processing failed');
    });
    return reply.send({ ok: true });
  });

  done();
};
