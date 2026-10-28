import { parseComplianceCommand } from '../../core/compliance/compliance.commands.js';
import { AttachmentRejectedError } from '../../core/errors/attachment.errors.js';
import { parsePracticeCommand } from '../../core/practice/practice.commands.js';
import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { bindUserToTenant, getTenantIdByInvite } from '../../core/tenant/tenant.invite.store.js';
import { getTenantByTelegramUserAsync } from '../../core/tenant/tenant.store.js';
import { UserRepository } from '../../data/repositories/user.repository.js';
import { errorLabel } from '../../shared/errors.js';

import { formatAttachmentRejection, formatAttachmentResult } from './attachment.formatter.js';
import { handleDevState } from './commands/devstate.command.js';
import { executeComplianceCommand } from './compliance.command.js';
import { formatPracticeCommandResult } from './practice.command.formatter.js';
import {
  formatAttachmentQuestion,
  parseAttachmentSelection,
  PendingAttachmentStore,
  resolveAttachmentTarget,
  type AttachmentCandidate,
  type TelegramFileRef,
} from './telegram.attachment-target.js';
import { TelegramClient } from './telegram.client.js';
import { mapTelegramErrorToMessage } from './telegram.errors.js';
import {
  getTelegramMemoryState,
  hasSeenUser,
  markUserSeen,
  resetTelegramMemory,
  setLastPractice,
} from './telegram.memory.js';
import { runtimeAwareExecute } from './telegram.runtimeAware.js';
import { safeReply } from './telegram.transport.js';

import type { ComplianceService } from '../../core/compliance/compliance.service.js';
import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';
import type { PrismaClient, UserRole } from '@prisma/client';

export type TelegramIdentity = {
  tenantId: string;
  userId: string;
  role: UserRole;
};

export type BotDeps = {
  prisma: PrismaClient;
  practiceService: Pick<PracticeApplicationService, 'executeCommand'> & {
    addAttachment?: PracticeApplicationService['addAttachment'];
    getMaxAttachmentBytes?: PracticeApplicationService['getMaxAttachmentBytes'];
    listPractices?: PracticeApplicationService['listPractices'];
  };
  complianceService?: Pick<ComplianceService, 'listDeadlines' | 'createDeadline' | 'closeDeadline'>;
  handleMessage: (input: string, identity: TelegramIdentity) => Promise<string>;
  log?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

let botInstance: TelegramClient | null = null;
// Telegram compresses photos to 1280 px, which hurts OCR on small print (found in staging).
const COMPRESSED_PHOTO_TIP =
  '\n\n💡 Per una lettura migliore invia il documento come File (📎 → File) invece che come ' +
  'Foto: Telegram comprime le foto.';
// Bot API limit for downloading files (getFile).
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
// Most recent practices considered when choosing where a received file goes.
const ATTACHMENT_PRACTICE_LOOKUP_LIMIT = 20;
// Files received while the user still has to choose the target practice.
const pendingAttachments = new PendingAttachmentStore();
let pollingActive = false;

async function shutdownTelegram() {
  try {
    if (botInstance && pollingActive) {
      await botInstance.stopPolling();
      pollingActive = false;
    }
  } catch (err) {
    console.error('Shutdown polling error', errorLabel(err));
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

function isGreeting(text: string): boolean {
  const t = text.toLowerCase().trim();

  if (t.startsWith('/')) return true;

  return ['ciao', 'hello', 'hi', 'help', 'start'].includes(t);
}

function onboardingMessage(role: UserRole): string {
  if (role === 'ADMIN' || role === 'OPERATOR') {
    return `👋 Ciao! Ti aiuto a gestire le pratiche.

Puoi:
• validarle
• completarle
• controllarne lo stato
• gestire le scadenze (DURC, sicurezza, bio, visite mediche, patentini)

Prova a scrivere:
"valida la pratica di Mario Rossi"
"scadenze" oppure "nuova scadenza durc 31/12/2026 DURC cooperativa"`;
  }

  return `👋 Ciao! Ti aiuto a gestire le tue pratiche.

Puoi:
• creare una pratica
• controllare lo stato
• chiedere aggiornamenti
• vedere le tue scadenze (scrivi "scadenze")

Prova a scrivere:
"crea pratica per Mario Rossi"`;
}

// Exported for tests, which drive it with a fake client.
export function attachMessageHandler(bot: TelegramClient, deps: BotDeps): void {
  bot.on('message', async (msg) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const text = msg.text ?? msg.caption ?? '';
    const chatId = msg.chat.id;
    if (!msg.from || msg.from.is_bot) return;
    if (!text && !msg.photo && !msg.document) return;

    // Identity is the Telegram user, never the chat/group id. This prevents
    // every member of a group from sharing the same tenant identity.
    const telegramId = String(msg.from.id);

    try {
      const trimmed = text.trim();
      const lower = trimmed.toLowerCase();

      if (trimmed.startsWith('/start')) {
        const parts = trimmed.split(/\s+/);
        const inviteCode = parts[1];

        if (inviteCode) {
          const tenantId = await getTenantIdByInvite(deps.prisma, inviteCode);

          if (!tenantId) {
            await bot.sendMessage(chatId, 'Codice invito non valido');
            return;
          }

          const user = await new UserRepository(deps.prisma).ensureTelegramUser(
            tenantId,
            telegramId,
          );
          await bindUserToTenant(deps.prisma, user.id, tenantId);

          deps.log?.info({ tenantId, requestId }, 'Telegram user linked to tenant');
          await bot.sendMessage(chatId, '🎵 Benvenuto! Sei stato collegato alla tua cooperativa.');

          return;
        }
      }

      let identity: Awaited<ReturnType<typeof getTenantByTelegramUserAsync>>;
      try {
        identity = await getTenantByTelegramUserAsync(deps.prisma, telegramId);
      } catch (err: unknown) {
        if (err instanceof TenantNotLinkedError) {
          await bot.sendMessage(
            chatId,
            'Il tuo account non è ancora collegato a una cooperativa.\nUsa `/start <codice invito>`.',
          );
          return;
        }
        throw err;
      }

      const tenant = identity.tenant;
      const dbUser = { id: identity.userId, role: identity.role };

      // Downloads a Telegram file and attaches it to the chosen practice (OCR included).
      const uploadToPractice = async (file: TelegramFileRef, practice: AttachmentCandidate) => {
        if (!deps.practiceService.addAttachment) return;
        try {
          const fileInfo = await bot.getFile(file.fileId);
          if (!fileInfo.file_path) {
            await bot.sendMessage(chatId, '⚠️ Impossibile scaricare il file da Telegram.');
            return;
          }
          const buffer = await bot.downloadFile(fileInfo.file_path);
          const uploadResult = await deps.practiceService.addAttachment({
            tenantId: tenant.id,
            userId: dbUser.id,
            practiceId: practice.id,
            fileName: file.fileName,
            mimeType: file.mimeType,
            content: buffer,
            hint: file.hint,
          });
          setLastPractice(dbUser.id, practice.id);

          await bot.sendMessage(
            chatId,
            `📁 Pratica: ${practice.name}\n` +
              formatAttachmentResult(uploadResult.attachment.ocrStatus, uploadResult.ocrResult) +
              (file.compressedPhoto && uploadResult.ocrResult?.reviewRequired
                ? COMPRESSED_PHOTO_TIP
                : ''),
          );
        } catch (uploadErr) {
          if (uploadErr instanceof AttachmentRejectedError) {
            await bot.sendMessage(chatId, formatAttachmentRejection(uploadErr));
            return;
          }
          deps.log?.error({ error: errorLabel(uploadErr), requestId }, 'Attachment upload error');
          await bot.sendMessage(
            chatId,
            "⚠️ Si è verificato un errore durante l'acquisizione del documento. Riprova più tardi.",
          );
        }
      };

      if (msg.photo || msg.document) {
        let file: TelegramFileRef;
        if (msg.document) {
          file = {
            fileId: msg.document.file_id,
            fileSize: msg.document.file_size,
            fileName: msg.document.file_name ?? `document_${Date.now()}.pdf`,
            mimeType: msg.document.mime_type ?? 'application/octet-stream',
            hint: text,
          };
        } else {
          const largest = msg.photo?.[msg.photo.length - 1];
          if (!largest) {
            await bot.sendMessage(chatId, '⚠️ Immagine non valida.');
            return;
          }
          file = {
            fileId: largest.file_id,
            fileSize: largest.file_size,
            fileName: `photo_${Date.now()}.jpg`,
            mimeType: 'image/jpeg',
            hint: text,
            compressedPhoto: true,
          };
        }

        // Reject oversized files before asking anything or downloading them from Telegram.
        // The Bot API cannot download files above 20 MB, whatever the configured limit.
        const maxBytes = Math.min(
          deps.practiceService.getMaxAttachmentBytes?.() ?? Infinity,
          TELEGRAM_DOWNLOAD_LIMIT_BYTES,
        );
        if (file.fileSize !== undefined && file.fileSize > maxBytes) {
          await bot.sendMessage(
            chatId,
            formatAttachmentRejection(
              new AttachmentRejectedError('ATTACHMENT_TOO_LARGE', 'File too large'),
            ),
          );
          return;
        }

        const practices = deps.practiceService.listPractices
          ? await deps.practiceService.listPractices({
              tenantId: tenant.id,
              userId: dbUser.id,
              limit: ATTACHMENT_PRACTICE_LOOKUP_LIMIT,
            })
          : [];
        const target = resolveAttachmentTarget(practices, text);

        if (target.type === 'none') {
          await bot.sendMessage(
            chatId,
            '📄 Ho ricevuto il tuo file, ma non ho trovato nessuna pratica a cui associarlo.\nCrea prima una pratica (es. "crea pratica Mario Rossi") e poi rimanda il file.',
          );
          return;
        }
        if (target.type === 'ask') {
          pendingAttachments.set(dbUser.id, file, target.candidates);
          await bot.sendMessage(chatId, formatAttachmentQuestion(target.candidates));
          return;
        }
        await uploadToPractice(file, target.practice);
        return;
      }

      const pending = pendingAttachments.get(dbUser.id);
      if (pending) {
        const selection = parseAttachmentSelection(trimmed, pending.candidates.length);
        if (selection === 'cancel') {
          pendingAttachments.delete(dbUser.id);
          await bot.sendMessage(chatId, 'Ok, il file non è stato associato a nessuna pratica.');
          return;
        }
        const chosen = typeof selection === 'number' ? pending.candidates[selection - 1] : null;
        if (chosen) {
          pendingAttachments.delete(dbUser.id);
          await uploadToPractice(pending.file, chosen);
          return;
        }
      }

      const complianceCommand = deps.complianceService ? parseComplianceCommand(trimmed) : null;
      if (complianceCommand && deps.complianceService) {
        const replyText = await executeComplianceCommand(complianceCommand, {
          complianceService: deps.complianceService,
          tenantId: tenant.id,
          userId: dbUser.id,
          role: dbUser.role,
        });
        await bot.sendMessage(chatId, replyText);
        return;
      }

      const command = parsePracticeCommand(trimmed);
      if (command) {
        const result = await deps.practiceService.executeCommand(command, {
          tenantId: tenant.id,
          userId: dbUser.id,
        });
        await bot.sendMessage(chatId, formatPracticeCommandResult(result));
        return;
      }

      if (lower === '/devstate') {
        if (process.env.NODE_ENV !== 'development') {
          return;
        }

        await runtimeAwareExecute(
          { reply: async (replyText: string) => bot.sendMessage(chatId, replyText) },
          async () => {
            await handleDevState({
              reply: async (runtimeReport) => {
                const memory = getTelegramMemoryState();
                const report = `${runtimeReport}

Memory:
- seen users: ${memory.seenUsersCount}
- memory entries: ${memory.memoryEntries}`;
                await bot.sendMessage(chatId, report);
              },
            });
          },
        );
        return;
      }

      if (lower === '/devreset') {
        if (process.env.NODE_ENV !== 'development') {
          return;
        }

        await runtimeAwareExecute(
          { reply: async (replyText: string) => bot.sendMessage(chatId, replyText) },
          async () => {
            resetTelegramMemory();
            await bot.sendMessage(chatId, '🧹 Dev state reset complete.');
          },
        );
        return;
      }

      if (lower.startsWith('/start')) {
        await runtimeAwareExecute(
          { reply: async (replyText: string) => bot.sendMessage(chatId, replyText) },
          async () => {
            if (!hasSeenUser(telegramId)) {
              markUserSeen(telegramId);
              await bot.sendMessage(chatId, onboardingMessage(dbUser.role));
            } else {
              await bot.sendMessage(chatId, '👋 Bentornato! Come posso aiutarti?');
            }
          },
        );
        return;
      }

      if (isGreeting(text)) {
        if (!hasSeenUser(telegramId)) {
          markUserSeen(telegramId);
          await bot.sendMessage(chatId, onboardingMessage(dbUser.role));
        } else {
          await bot.sendMessage(chatId, '👋 Bentornato! Come posso aiutarti?');
        }
        return;
      }

      // Defensive layer: never let any Telegram command reach the AI pipeline.
      if (trimmed.startsWith('/')) {
        await bot.sendMessage(chatId, onboardingMessage(dbUser.role));
        return;
      }

      const response = await deps.handleMessage(text, {
        tenantId: tenant.id,
        userId: dbUser.id,
        role: dbUser.role,
      });
      await bot.sendMessage(chatId, response);
    } catch (err) {
      deps.log?.error({ error: errorLabel(err), requestId }, 'Telegram handler error');

      let replyText: string;
      try {
        replyText = mapTelegramErrorToMessage(err);
      } catch {
        replyText = '⚠️ Si è verificato un problema temporaneo. Riprova tra poco.';
      }

      try {
        await safeReply(
          { reply: (replyTextValue: string) => bot.sendMessage(chatId, replyTextValue) },
          replyText,
        );
      } catch (sendErr) {
        deps.log?.error(
          { error: errorLabel(sendErr), requestId },
          'Failed to send Telegram error reply',
        );
      }
    }
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
