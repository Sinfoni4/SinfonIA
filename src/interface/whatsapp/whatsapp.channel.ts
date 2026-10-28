import { createHmac, timingSafeEqual } from 'node:crypto';

import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { bindUserToTenant, getTenantIdByInvite } from '../../core/tenant/tenant.invite.store.js';
import { getTenantById } from '../../core/tenant/tenant.store.js';
import { WhatsappIdentityRepository } from '../../data/repositories/whatsapp-identity.repository.js';
import { errorLabel } from '../../shared/errors.js';
import { ConversationService } from '../conversation/conversation.service.js';

import type { WhatsAppClient } from './whatsapp.client.js';
import type {
  ChannelIdentityProvider,
  ConversationDeps,
  InboundMessage,
} from '../conversation/conversation.service.js';
import type { PrismaClient } from '@prisma/client';

export const WHATSAPP_COMPRESSED_PHOTO_TIP =
  '\n\n💡 Per una lettura migliore invia il documento come Documento (📎 → Documento) invece ' +
  'che come foto: WhatsApp comprime le foto.';

const UNSUPPORTED_MESSAGE =
  'ℹ️ Posso leggere messaggi di testo, foto e documenti (PDF o immagini). Gli altri tipi di messaggio non sono supportati.';

/** A message received from the WhatsApp Cloud API webhook, reduced to what SinfonIA uses. */
export type WhatsAppIncoming = {
  id: string;
  /** Sender phone number, international format without "+". */
  from: string;
  type: string;
  text: string;
  media?: { id: string; mimeType?: string; filename?: string; isPhoto: boolean };
};

/**
 * X-Hub-Signature-256 is "sha256=" + HMAC-SHA256 of the raw request body with the app secret.
 * Compared in constant time; any parsing or re-serialization of the body would break it.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`,
  );
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type WebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
          image?: { id?: string; mime_type?: string; caption?: string };
          document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
        }>;
      };
    }>;
  }>;
};

/** Extracts the user messages from a webhook payload; delivery statuses are ignored. */
export function parseWebhookPayload(payload: unknown): WhatsAppIncoming[] {
  const messages: WhatsAppIncoming[] = [];
  for (const entry of (payload as WebhookPayload | null)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from || !message.type) continue;
        const base = { id: message.id, from: message.from, type: message.type };
        if (message.type === 'text') {
          messages.push({ ...base, text: message.text?.body ?? '' });
        } else if (message.type === 'image' && message.image?.id) {
          messages.push({
            ...base,
            text: message.image.caption ?? '',
            media: { id: message.image.id, mimeType: message.image.mime_type, isPhoto: true },
          });
        } else if (message.type === 'document' && message.document?.id) {
          messages.push({
            ...base,
            text: message.document.caption ?? '',
            media: {
              id: message.document.id,
              mimeType: message.document.mime_type,
              filename: message.document.filename,
              isPhoto: false,
            },
          });
        } else {
          messages.push({ ...base, text: '' });
        }
      }
    }
  }
  return messages;
}

/** WhatsApp users are identified by their phone number, linked to a user with an invite code. */
export function createWhatsAppIdentityProvider(prisma: PrismaClient): ChannelIdentityProvider {
  const identities = new WhatsappIdentityRepository(prisma);
  return {
    async link(inviteCode, phone) {
      const tenantId = await getTenantIdByInvite(prisma, inviteCode);
      if (!tenantId) return null;
      const { userId } = await identities.ensureLinkedUser(tenantId, phone);
      await bindUserToTenant(prisma, userId, tenantId);
      return tenantId;
    },
    async resolve(phone) {
      const identity = await identities.findLatestByPhone(phone);
      if (!identity) throw new TenantNotLinkedError();
      return {
        tenant: await getTenantById(prisma, identity.tenantId),
        userId: identity.userId,
        role: identity.role,
      };
    },
  };
}

// Meta retries a webhook delivery when the reply is slow or fails: the same message id must not
// be processed twice. Only recent ids are kept.
const MAX_REMEMBERED_IDS = 1000;

/**
 * WhatsApp adapter: turns webhook messages into conversation messages and sends the replies
 * through the Cloud API. Messages of one sender are handled in order.
 */
export class WhatsAppChannel {
  private readonly conversation: ConversationService;
  private readonly seenIds = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Pick<WhatsAppClient, 'sendText' | 'getMedia' | 'downloadMedia'>,
    deps: ConversationDeps & { prisma: PrismaClient },
    private readonly log?: ConversationDeps['log'],
    identity: ChannelIdentityProvider = createWhatsAppIdentityProvider(deps.prisma),
  ) {
    this.conversation = new ConversationService(deps, {
      name: 'whatsapp',
      identity,
      compressedPhotoTip: WHATSAPP_COMPRESSED_PHOTO_TIP,
    });
  }

  /** Accepts a verified webhook payload; returns once its messages have been handled. */
  async receive(payload: unknown): Promise<void> {
    const work: Array<Promise<void>> = [];
    for (const message of parseWebhookPayload(payload)) {
      if (this.seenIds.has(message.id)) continue;
      this.remember(message.id);
      const previous = this.queues.get(message.from) ?? Promise.resolve();
      const next = previous.then(() => this.handle(message));
      this.queues.set(message.from, next);
      work.push(
        next.finally(() => {
          if (this.queues.get(message.from) === next) this.queues.delete(message.from);
        }),
      );
    }
    await Promise.all(work);
  }

  private async handle(message: WhatsAppIncoming): Promise<void> {
    const reply = (text: string) => this.client.sendText(message.from, text);
    try {
      if (message.type !== 'text' && !message.media) {
        await reply(UNSUPPORTED_MESSAGE);
        return;
      }
      const inbound: InboundMessage = { senderId: message.from, text: message.text };
      if (message.media) {
        const media = message.media;
        const extension = media.isPhoto ? 'jpg' : 'pdf';
        inbound.file = {
          fileName: media.filename ?? `whatsapp_${Date.now()}.${extension}`,
          mimeType: media.mimeType ?? 'application/octet-stream',
          hint: message.text,
          compressedPhoto: media.isPhoto,
          download: async () => {
            const info = await this.client.getMedia(media.id);
            return this.client.downloadMedia(info.url);
          },
        };
      }
      await this.conversation.handle(inbound, reply);
    } catch (err: unknown) {
      this.log?.error({ error: errorLabel(err), channel: 'whatsapp' }, 'WhatsApp message failed');
    }
  }

  private remember(id: string): void {
    this.seenIds.add(id);
    if (this.seenIds.size > MAX_REMEMBERED_IDS) {
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
  }
}
