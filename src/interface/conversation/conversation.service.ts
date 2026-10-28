import { parseComplianceCommand } from '../../core/compliance/compliance.commands.js';
import { AttachmentRejectedError } from '../../core/errors/attachment.errors.js';
import { parsePracticeCommand } from '../../core/practice/practice.commands.js';
import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { errorLabel } from '../../shared/errors.js';
import {
  formatAttachmentRejection,
  formatAttachmentResult,
} from '../telegram/attachment.formatter.js';
import { handleDevState } from '../telegram/commands/devstate.command.js';
import { executeComplianceCommand } from '../telegram/compliance.command.js';
import { formatPracticeCommandResult } from '../telegram/practice.command.formatter.js';
import {
  formatAttachmentQuestion,
  parseAttachmentSelection,
  PendingAttachmentStore,
  resolveAttachmentTarget,
  type AttachmentCandidate,
} from '../telegram/telegram.attachment-target.js';
import { mapTelegramErrorToMessage } from '../telegram/telegram.errors.js';
import {
  getTelegramMemoryState,
  hasSeenUser,
  markUserSeen,
  resetTelegramMemory,
  setLastPractice,
} from '../telegram/telegram.memory.js';
import { runtimeAwareExecute } from '../telegram/telegram.runtimeAware.js';

import type { ComplianceService } from '../../core/compliance/compliance.service.js';
import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';
import type { Tenant } from '../../core/tenant/tenant.store.js';
import type { UserRole } from '@prisma/client';

/**
 * Channel-independent conversation logic shared by Telegram and WhatsApp: linking with an invite
 * code, identity, attachments with practice selection, deterministic commands (practices and
 * deadlines) and the AI interpreter. Channels only translate their messages into an
 * `InboundMessage` and send the replies back, so both behave the same way.
 */

export type ConversationIdentity = {
  tenantId: string;
  userId: string;
  role: UserRole;
};

/** A file received on a channel; downloaded only once the target practice is known. */
export type InboundFile = {
  fileName: string;
  mimeType: string;
  fileSize?: number;
  /** Sent as a compressed photo (e.g. a Telegram photo): OCR works better on files. */
  compressedPhoto?: boolean;
  /** Caption sent with the file: a hint for the document type (kept while a practice is chosen). */
  hint?: string;
  download: () => Promise<Buffer>;
};

export type InboundMessage = {
  /** Sender identity on the channel: the Telegram user id or the WhatsApp phone number. */
  senderId: string;
  /** Message text, or the caption of a file. */
  text: string;
  file?: InboundFile;
};

export interface ChannelIdentityProvider {
  /** Links the sender to the tenant of an invite code; null when the code is unknown. */
  link(inviteCode: string, senderId: string): Promise<string | null>;
  /** Throws TenantNotLinkedError when the sender is not linked to any tenant. */
  resolve(senderId: string): Promise<{ tenant: Tenant; userId: string; role: UserRole }>;
}

export type ConversationDeps = {
  practiceService: Pick<PracticeApplicationService, 'executeCommand'> & {
    addAttachment?: PracticeApplicationService['addAttachment'];
    getMaxAttachmentBytes?: PracticeApplicationService['getMaxAttachmentBytes'];
    listPractices?: PracticeApplicationService['listPractices'];
  };
  complianceService?: Pick<ComplianceService, 'listDeadlines' | 'createDeadline' | 'closeDeadline'>;
  handleMessage: (input: string, identity: ConversationIdentity) => Promise<string>;
  log?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

export type ChannelOptions = {
  /** Channel name, used in logs and to keep users of different channels apart. */
  name: 'telegram' | 'whatsapp';
  identity: ChannelIdentityProvider;
  /** Largest file the channel lets the bot download (Telegram: 20 MB). */
  maxDownloadBytes?: number;
  /** Added to the reply when a compressed photo gives a read that needs review. */
  compressedPhotoTip?: string;
};

type Reply = (text: string) => Promise<unknown>;

// Most recent practices considered when choosing where a received file goes.
const ATTACHMENT_PRACTICE_LOOKUP_LIMIT = 20;

// Telegram compresses photos to 1280 px, which hurts OCR on small print (found in staging).
export const TELEGRAM_COMPRESSED_PHOTO_TIP =
  '\n\n💡 Per una lettura migliore invia il documento come File (📎 → File) invece che come ' +
  'Foto: Telegram comprime le foto.';

const LINK_COMMAND = /^\/?start\s+(\S+)/i;

function isGreeting(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.startsWith('/')) return true;
  return ['ciao', 'hello', 'hi', 'help', 'start'].includes(t);
}

export function onboardingMessage(role: UserRole): string {
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

export class ConversationService {
  // Files received while the user still has to choose the target practice.
  private readonly pendingAttachments = new PendingAttachmentStore<InboundFile>();

  constructor(
    private readonly deps: ConversationDeps,
    private readonly channel: ChannelOptions,
  ) {}

  async handle(message: InboundMessage, reply: Reply): Promise<void> {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const text = message.text;
    if (!text && !message.file) return;

    try {
      await this.process(message, reply, requestId);
    } catch (err) {
      this.deps.log?.error(
        { error: errorLabel(err), requestId, channel: this.channel.name },
        'Conversation handler error',
      );
      let replyText: string;
      try {
        replyText = mapTelegramErrorToMessage(err);
      } catch {
        replyText = '⚠️ Si è verificato un problema temporaneo. Riprova tra poco.';
      }
      try {
        await reply(replyText);
      } catch (sendErr) {
        this.deps.log?.error(
          { error: errorLabel(sendErr), requestId, channel: this.channel.name },
          'Failed to send error reply',
        );
      }
    }
  }

  private async process(message: InboundMessage, reply: Reply, requestId: string): Promise<void> {
    const { deps } = this;
    const text = message.text;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    // Keeps users of different channels apart in the in-memory "seen" set.
    const seenKey = `${this.channel.name}:${message.senderId}`;

    const inviteCode = LINK_COMMAND.exec(trimmed)?.[1];
    if (inviteCode) {
      const tenantId = await this.channel.identity.link(inviteCode, message.senderId);
      if (!tenantId) {
        await reply('Codice invito non valido');
        return;
      }
      deps.log?.info({ tenantId, requestId, channel: this.channel.name }, 'User linked to tenant');
      await reply('🎵 Benvenuto! Sei stato collegato alla tua cooperativa.');
      return;
    }

    let identity: Awaited<ReturnType<ChannelIdentityProvider['resolve']>>;
    try {
      identity = await this.channel.identity.resolve(message.senderId);
    } catch (err: unknown) {
      if (err instanceof TenantNotLinkedError) {
        await reply(
          'Il tuo account non è ancora collegato a una cooperativa.\nScrivi `start <codice invito>`.',
        );
        return;
      }
      throw err;
    }

    const tenant = identity.tenant;
    const dbUser = { id: identity.userId, role: identity.role };

    // Downloads the file and attaches it to the chosen practice (OCR included).
    const uploadToPractice = async (file: InboundFile, practice: AttachmentCandidate) => {
      if (!deps.practiceService.addAttachment) return;
      try {
        const content = await file.download();
        const uploadResult = await deps.practiceService.addAttachment({
          tenantId: tenant.id,
          userId: dbUser.id,
          practiceId: practice.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          content,
          hint: file.hint,
        });
        setLastPractice(dbUser.id, practice.id);

        await reply(
          `📁 Pratica: ${practice.name}\n` +
            formatAttachmentResult(uploadResult.attachment.ocrStatus, uploadResult.ocrResult) +
            (file.compressedPhoto && uploadResult.ocrResult?.reviewRequired
              ? (this.channel.compressedPhotoTip ?? '')
              : ''),
        );
      } catch (uploadErr) {
        if (uploadErr instanceof AttachmentRejectedError) {
          await reply(formatAttachmentRejection(uploadErr));
          return;
        }
        deps.log?.error({ error: errorLabel(uploadErr), requestId }, 'Attachment upload error');
        await reply(
          "⚠️ Si è verificato un errore durante l'acquisizione del documento. Riprova più tardi.",
        );
      }
    };

    if (message.file) {
      const file = message.file;
      // Reject oversized files before asking anything or downloading them.
      const maxBytes = Math.min(
        deps.practiceService.getMaxAttachmentBytes?.() ?? Infinity,
        this.channel.maxDownloadBytes ?? Infinity,
      );
      if (file.fileSize !== undefined && file.fileSize > maxBytes) {
        await reply(
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
        await reply(
          '📄 Ho ricevuto il tuo file, ma non ho trovato nessuna pratica a cui associarlo.\nCrea prima una pratica (es. "crea pratica Mario Rossi") e poi rimanda il file.',
        );
        return;
      }
      if (target.type === 'ask') {
        this.pendingAttachments.set(dbUser.id, file, target.candidates);
        await reply(formatAttachmentQuestion(target.candidates));
        return;
      }
      await uploadToPractice(file, target.practice);
      return;
    }

    const pending = this.pendingAttachments.get(dbUser.id);
    if (pending) {
      const selection = parseAttachmentSelection(trimmed, pending.candidates.length);
      if (selection === 'cancel') {
        this.pendingAttachments.delete(dbUser.id);
        await reply('Ok, il file non è stato associato a nessuna pratica.');
        return;
      }
      const chosen = typeof selection === 'number' ? pending.candidates[selection - 1] : null;
      if (chosen) {
        this.pendingAttachments.delete(dbUser.id);
        await uploadToPractice(pending.file, chosen);
        return;
      }
    }

    const complianceCommand = deps.complianceService ? parseComplianceCommand(trimmed) : null;
    if (complianceCommand && deps.complianceService) {
      await reply(
        await executeComplianceCommand(complianceCommand, {
          complianceService: deps.complianceService,
          tenantId: tenant.id,
          userId: dbUser.id,
          role: dbUser.role,
        }),
      );
      return;
    }

    const command = parsePracticeCommand(trimmed);
    if (command) {
      const result = await deps.practiceService.executeCommand(command, {
        tenantId: tenant.id,
        userId: dbUser.id,
      });
      await reply(formatPracticeCommandResult(result));
      return;
    }

    if (lower === '/devstate' || lower === '/devreset') {
      if (process.env.NODE_ENV !== 'development') return;
      await runtimeAwareExecute({ reply }, async () => {
        if (lower === '/devreset') {
          resetTelegramMemory();
          await reply('🧹 Dev state reset complete.');
          return;
        }
        await handleDevState({
          reply: async (runtimeReport) => {
            const memory = getTelegramMemoryState();
            await reply(`${runtimeReport}

Memory:
- seen users: ${memory.seenUsersCount}
- memory entries: ${memory.memoryEntries}`);
          },
        });
      });
      return;
    }

    if (lower.startsWith('/start') || isGreeting(text)) {
      if (!hasSeenUser(seenKey)) {
        markUserSeen(seenKey);
        await reply(onboardingMessage(dbUser.role));
      } else {
        await reply('👋 Bentornato! Come posso aiutarti?');
      }
      return;
    }

    // Defensive layer: never let a slash command reach the AI pipeline.
    if (trimmed.startsWith('/')) {
      await reply(onboardingMessage(dbUser.role));
      return;
    }

    await reply(
      await deps.handleMessage(text, { tenantId: tenant.id, userId: dbUser.id, role: dbUser.role }),
    );
  }
}
