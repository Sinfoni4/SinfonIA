import { UserRepository } from '../../data/repositories/user.repository.js';
import { errorLabel } from '../../shared/errors.js';
import { log } from '../../shared/log.js';
import { createMembershipIdentityProvider } from '../conversation/channel.identity.js';
import {
  ConversationService,
  TELEGRAM_COMPRESSED_PHOTO_TIP,
  VOICE_NOT_SUPPORTED,
} from '../conversation/conversation.service.js';

import { TelegramClient } from './telegram.client.js';

import type {
  ChannelIdentityProvider,
  ConversationDeps,
  ConversationIdentity,
  InboundMessage,
} from '../conversation/conversation.service.js';
import type { PrismaClient } from '@prisma/client';

export type TelegramIdentity = ConversationIdentity;

export type BotDeps = ConversationDeps & {
  prisma: PrismaClient;
  /** Overrides how Telegram users are identified (tests). */
  identity?: ChannelIdentityProvider;
};

let botInstance: TelegramClient | null = null;
// Bot API limit for downloading files (getFile).
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
let pollingActive = false;

async function shutdownTelegram() {
  try {
    if (botInstance && pollingActive) {
      await botInstance.stopPolling();
      pollingActive = false;
    }
  } catch (err) {
    log.error({ error: errorLabel(err) }, 'Telegram polling shutdown failed');
  }
}

export async function stopTelegramPollingForRestart() {
  await shutdownTelegram();
}

process.once('SIGINT', () => {
  void shutdownTelegram();
});
process.once('SIGTERM', () => {
  void shutdownTelegram();
});
process.once('beforeExit', () => {
  void shutdownTelegram();
});

/** Telegram users are identified by their numeric Telegram user id (channel identity). */
export function createTelegramIdentityProvider(prisma: PrismaClient): ChannelIdentityProvider {
  return createMembershipIdentityProvider(prisma, 'TELEGRAM', async (tenantId, telegramId) => ({
    userId: (await new UserRepository(prisma).ensureTelegramUser(tenantId, telegramId)).id,
  }));
}

// Exported for tests, which drive it with a fake client.
export function attachMessageHandler(bot: TelegramClient, deps: BotDeps): void {
  const conversation = new ConversationService(deps, {
    name: 'telegram',
    identity: deps.identity ?? createTelegramIdentityProvider(deps.prisma),
    maxDownloadBytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES,
    compressedPhotoTip: TELEGRAM_COMPRESSED_PHOTO_TIP,
  });

  bot.on('message', async (msg) => {
    if (!msg.from || msg.from.is_bot) return;
    const chatId = msg.chat.id;
    const reply = (text: string) => bot.sendMessage(chatId, text);
    // Without a text, a voice message would otherwise get no answer at all.
    if (msg.voice || msg.audio || msg.video_note) {
      await reply(VOICE_NOT_SUPPORTED);
      return;
    }
    const download = (fileId: string) => async () => {
      const info = await bot.getFile(fileId);
      if (!info.file_path) throw new Error('Telegram returned no file path');
      return bot.downloadFile(info.file_path);
    };

    // Identity is the Telegram user, never the chat/group id. This prevents
    // every member of a group from sharing the same tenant identity.
    const inbound: InboundMessage = {
      senderId: String(msg.from.id),
      text: msg.text ?? msg.caption ?? '',
    };
    if (msg.document) {
      inbound.file = {
        fileName: msg.document.file_name ?? `document_${Date.now()}.pdf`,
        mimeType: msg.document.mime_type ?? 'application/octet-stream',
        fileSize: msg.document.file_size,
        hint: inbound.text,
        download: download(msg.document.file_id),
      };
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      if (!largest) {
        await reply('⚠️ Immagine non valida.');
        return;
      }
      inbound.file = {
        fileName: `photo_${Date.now()}.jpg`,
        mimeType: 'image/jpeg',
        fileSize: largest.file_size,
        hint: inbound.text,
        compressedPhoto: true,
        download: download(largest.file_id),
      };
    }

    await conversation.handle(inbound, reply);
  });
}

export function startTelegramBot(token: string, deps: BotDeps): TelegramClient {
  if (pollingActive) {
    if (botInstance) {
      return botInstance;
    }
  }

  if (botInstance) {
    return botInstance;
  }

  const bot = new TelegramClient(token);

  bot.on('polling_error', (err) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram polling error');
  });

  bot.on('webhook_error', (err) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram webhook error');
  });

  bot.on('error', (err) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram transport error');
  });

  botInstance = bot;
  deps.log?.info({ transport: 'telegram', mode: 'polling' }, 'Telegram bot started');
  attachMessageHandler(bot, deps);

  pollingActive = true;
  void bot.startPolling().catch((err: unknown) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram polling start failure');
    pollingActive = false;
  });

  return bot;
}

export class TelegramBotService {
  constructor(private readonly deps: BotDeps) {}

  start(token: string) {
    startTelegramBot(token, this.deps);
  }
}
