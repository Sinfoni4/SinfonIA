import { UserRepository } from '../../data/repositories/user.repository.js';
import { errorLabel } from '../../shared/errors.js';
import { log } from '../../shared/log.js';
import { createMembershipIdentityProvider } from '../conversation/channel.identity.js';
import {
  ConversationService,
  MENU_BUTTONS,
  TELEGRAM_COMPRESSED_PHOTO_TIP,
  VOICE_NOT_SUPPORTED,
} from '../conversation/conversation.service.js';

import { TelegramClient } from './telegram.client.js';

import type { ReplyMarkup } from './telegram.client.js';
import type {
  ChannelIdentityProvider,
  ConversationDeps,
  ConversationIdentity,
  InboundMessage,
  ReplyOptions,
} from '../conversation/conversation.service.js';
import type { PrismaClient } from '@prisma/client';

export type TelegramIdentity = ConversationIdentity;

export type BotDeps = ConversationDeps & {
  prisma: PrismaClient;
  /** Overrides how Telegram users are identified (tests). */
  identity?: ChannelIdentityProvider;
  /** Dashboard page of the documents to verify, offered by «Modifica» (A2). */
  reviewUrl?: string;
};

/**
 * Answers of the buttons sent, by chat and message (A2). A press only carries a short token
 * («b0», «b1»…): the answer is found here, so Telegram's 64-byte limit on button data never
 * cuts it. Kept in memory, the most recent ones only: after a restart old buttons expire.
 */
export class ButtonAnswers {
  private readonly answers = new Map<string, string[]>();

  constructor(private readonly capacity = 1000) {}

  remember(chatId: number, messageId: number, answers: string[]): void {
    this.answers.set(`${chatId}:${messageId}`, answers);
    if (this.answers.size > this.capacity) {
      const oldest = this.answers.keys().next().value;
      if (oldest !== undefined) this.answers.delete(oldest);
    }
  }

  /** The answer of a pressed button, once: the buttons of a message answer only one time. */
  take(chatId: number, messageId: number, data: string): string | null {
    const key = `${chatId}:${messageId}`;
    const index = /^b(\d{1,2})$/.exec(data)?.[1];
    const answer = index === undefined ? undefined : this.answers.get(key)?.[Number(index)];
    if (answer === undefined) return null;
    this.answers.delete(key);
    return answer;
  }
}

/** Telegram markup for the reply options: buttons under the message, or the main menu. */
export function replyMarkup(options: ReplyOptions | undefined): ReplyMarkup | undefined {
  if (options?.buttons?.length) {
    // Short labels two per row, long ones alone.
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    options.buttons.forEach((b, i) => {
      const button = { text: b.label, callback_data: `b${i}` };
      const last = rows.at(-1);
      if (last && last.length === 1 && b.label.length <= 16 && last[0].text.length <= 16) {
        last.push(button);
      } else {
        rows.push([button]);
      }
    });
    return { inline_keyboard: rows };
  }
  if (options?.menu) {
    return {
      // Two entries per row.
      keyboard: MENU_BUTTONS.reduce<Array<Array<{ text: string }>>>((rows, b, i) => {
        if (i % 2 === 0) rows.push([{ text: b.label }]);
        else rows[rows.length - 1].push({ text: b.label });
        return rows;
      }, []),
      resize_keyboard: true,
      is_persistent: true,
    };
  }
  return undefined;
}

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
  // A Telegram file_id stays valid: a file waiting for an answer is downloaded again from it.
  const download = (fileId: string) => async () => {
    const info = await bot.getFile(fileId);
    if (!info.file_path) throw new Error('Telegram returned no file path');
    return bot.downloadFile(info.file_path);
  };
  const conversation = new ConversationService(deps, {
    name: 'telegram',
    identity: deps.identity ?? createTelegramIdentityProvider(deps.prisma),
    maxDownloadBytes: TELEGRAM_DOWNLOAD_LIMIT_BYTES,
    compressedPhotoTip: TELEGRAM_COMPRESSED_PHOTO_TIP,
    reviewUrl: deps.reviewUrl,
    downloadRef: download,
  });
  const buttons = new ButtonAnswers();

  /** Replies in a chat; the answers of the buttons are kept for when they are pressed. */
  const replyIn = (chatId: number) => async (text: string, options?: ReplyOptions) => {
    const markup = replyMarkup(options);
    const sent = markup
      ? await bot.sendMessage(chatId, text, { reply_markup: markup })
      : await bot.sendMessage(chatId, text);
    // A client that returns no message (tests, errors swallowed upstream) simply gets no buttons.
    const messageId = (sent as { message_id?: number } | undefined)?.message_id;
    if (options?.buttons?.length && messageId !== undefined) {
      buttons.remember(
        chatId,
        messageId,
        options.buttons.map((b) => b.answer),
      );
    }
    return sent;
  };

  // A pressed button is the same as writing its answer, from the person who pressed it.
  bot.on('callback_query', async (query) => {
    if (query.from.is_bot || !query.message || !query.data) {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    const chatId = query.message.chat.id;
    const answer = buttons.take(chatId, query.message.message_id, query.data);
    if (answer === null) {
      await bot.answerCallbackQuery(query.id, 'Pulsante scaduto: scrivi la risposta.');
      return;
    }
    await bot.answerCallbackQuery(query.id);
    await bot.clearInlineKeyboard(chatId, query.message.message_id).catch(() => undefined);
    await conversation.handle({ senderId: String(query.from.id), text: answer }, replyIn(chatId));
  });

  bot.on('message', async (msg) => {
    if (!msg.from || msg.from.is_bot) return;
    const chatId = msg.chat.id;
    const reply = replyIn(chatId);
    // Without a text, a voice message would otherwise get no answer at all.
    if (msg.voice || msg.audio || msg.video_note) {
      await reply(VOICE_NOT_SUPPORTED);
      return;
    }
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
        ref: msg.document.file_id,
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
        ref: largest.file_id,
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
