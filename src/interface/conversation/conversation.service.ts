import { can } from '../../core/authz/authorization.service.js';
import { parseComplianceCommand } from '../../core/compliance/compliance.commands.js';
import { AttachmentRejectedError } from '../../core/errors/attachment.errors.js';
import { MemberAccessError } from '../../core/identity/member-access.service.js';
import {
  OrganizationChoiceRequiredError,
  type MembershipOption,
} from '../../core/identity/membership.service.js';
import {
  parsePracticeCommand,
  type ChatTransition,
  type PracticeCommand,
} from '../../core/practice/practice.commands.js';
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
import { runtimeAwareExecute } from '../telegram/telegram.runtimeAware.js';

import { suggestCommand } from './command.typos.js';
import { InMemoryConversationMemory, type ConversationMemory } from './conversation.memory.js';

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
  /**
   * Throws TenantNotLinkedError when the sender is not linked to any tenant, and
   * OrganizationChoiceRequiredError when they belong to several organizations.
   */
  resolve(senderId: string): Promise<{ tenant: Tenant; userId: string; role: UserRole }>;
  /** Loads an organization chosen among the memberships of an OrganizationChoiceRequiredError. */
  tenantFor?(tenantId: string): Promise<Tenant>;
}

export type ConversationDeps = {
  practiceService: Pick<PracticeApplicationService, 'executeCommand'> & {
    addAttachment?: PracticeApplicationService['addAttachment'];
    getMaxAttachmentBytes?: PracticeApplicationService['getMaxAttachmentBytes'];
    listPractices?: PracticeApplicationService['listPractices'];
  };
  complianceService?: Pick<ComplianceService, 'listDeadlines' | 'createDeadline' | 'closeDeadline'>;
  handleMessage: (input: string, identity: ConversationIdentity) => Promise<string>;
  /** Turns the scheduled export in chat on or off for the person (D5b); returns whether it changed. */
  scheduledExport?: (orgId: string, userId: string, enabled: boolean) => Promise<boolean>;
  /** Defaults to process memory; production passes the database one. */
  memory?: ConversationMemory;
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

// A transition of someone else's practice waits this long for the person's confirmation (C2).
const TRANSITION_CONFIRMATION_MS = 5 * 60_000;
const CONFIRMATION = /^(s[iì]|conferm[ao])[.!]?$/i;

type PendingTransition = {
  tenantId: string;
  practiceId: string;
  nextState: ChatTransition;
  expiresAt: number;
};

// Telegram compresses photos to 1280 px, which hurts OCR on small print (found in staging).
export const TELEGRAM_COMPRESSED_PHOTO_TIP =
  '\n\n💡 Per una lettura migliore invia il documento come File (📎 → File) invece che come ' +
  'Foto: Telegram comprime le foto.';

/** Voice messages are not transcribed yet (speech-to-text provider still to be chosen). */
export const VOICE_NOT_SUPPORTED =
  '🎙️ I messaggi vocali non sono ancora supportati: scrivi la richiesta come testo.';

const LINK_COMMAND = /^\/?start\s+(\S+)/i;
const SCHEDULED_EXPORT_COMMAND = /^(attiva|disattiva)\s+export\s+pianificato$/i;
const ORG_COMMAND = /^\/?azienda(?:\s+(\d{1,2}))?$/i;

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'amministratore',
  OPERATOR: 'operatore',
  MEMBER: 'collaboratore',
};

export function formatOrganizationChoice(options: MembershipOption[], activeId?: string | null) {
  const lines = options.map(
    (o, i) =>
      `${i + 1}. ${o.tenantName} (${ROLE_LABELS[o.role]})${o.tenantId === activeId ? ' ← attuale' : ''}`,
  );
  return [
    '🏢 Fai parte di più organizzazioni. Scegli con cui lavorare scrivendo «azienda» e il numero:',
    '',
    ...lines,
  ].join('\n');
}

function isGreeting(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.startsWith('/')) return true;
  return ['ciao', 'hello', 'hi', 'help', 'start'].includes(t);
}

export function onboardingMessage(role: UserRole): string {
  if (can(role, 'practice.transition')) {
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
  // Transitions of practices of others waiting for «sì», by person (C2).
  private readonly pendingTransitions = new Map<string, PendingTransition>();
  // Commands suggested after a typing error, waiting for «sì», by person.
  private readonly pendingSuggestions = new Map<
    string,
    { tenantId: string; text: string; expiresAt: number }
  >();

  /** Whether a text is a command this channel handles without the AI. */
  private isCommand(text: string): boolean {
    return (
      (Boolean(this.deps.scheduledExport) && SCHEDULED_EXPORT_COMMAND.test(text)) ||
      (Boolean(this.deps.complianceService) && parseComplianceCommand(text) !== null) ||
      parsePracticeCommand(text) !== null
    );
  }
  private readonly memory: ConversationMemory;

  constructor(
    private readonly deps: ConversationDeps,
    private readonly channel: ChannelOptions,
  ) {
    this.memory = deps.memory ?? new InMemoryConversationMemory();
  }

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

  /**
   * A person in several organizations works in the one they chose («azienda N»), kept in the
   * conversation memory. Returns the identity to continue with, or null when the reply is done.
   */
  private async chooseOrganization(
    choice: OrganizationChoiceRequiredError,
    orgCommand: RegExpExecArray | null,
    reply: Reply,
  ): Promise<Awaited<ReturnType<ChannelIdentityProvider['resolve']>> | null> {
    const active = await this.memory.getActiveOrg(choice.userId);
    if (orgCommand?.[1]) {
      const picked = choice.options[Number(orgCommand[1]) - 1];
      if (!picked) {
        await reply(formatOrganizationChoice(choice.options, active));
        return null;
      }
      await this.memory.setActiveOrg(choice.userId, picked.tenantId);
      await reply(`✅ Ora lavori per ${picked.tenantName} come ${ROLE_LABELS[picked.role]}.`);
      return null;
    }
    const current = choice.options.find((o) => o.tenantId === active);
    if (!current || orgCommand || !this.channel.identity.tenantFor) {
      await reply(formatOrganizationChoice(choice.options, current?.tenantId));
      return null;
    }
    return {
      tenant: await this.channel.identity.tenantFor(current.tenantId),
      userId: choice.userId,
      role: current.role,
    };
  }

  private async process(message: InboundMessage, reply: Reply, requestId: string): Promise<void> {
    const { deps } = this;
    const text = message.text;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

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

    const orgCommand = ORG_COMMAND.exec(trimmed);
    let identity: Awaited<ReturnType<ChannelIdentityProvider['resolve']>>;
    try {
      identity = await this.channel.identity.resolve(message.senderId);
      if (orgCommand) {
        await reply(`🏢 Lavori per ${identity.tenant.name}.`);
        return;
      }
    } catch (err: unknown) {
      if (err instanceof TenantNotLinkedError) {
        await reply(
          'Il tuo account non è ancora collegato a una cooperativa.\nScrivi `start <codice invito>`.',
        );
        return;
      }
      if (!(err instanceof OrganizationChoiceRequiredError)) throw err;
      const chosen = await this.chooseOrganization(err, orgCommand, reply);
      if (!chosen) return;
      identity = chosen;
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
        await this.memory.setLastPractice(tenant.id, dbUser.id, practice.id);

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

    // Any message answers a pending confirmation: «sì» executes it, anything else cancels it.
    const pendingTransition = this.pendingTransitions.get(dbUser.id);
    if (pendingTransition) {
      this.pendingTransitions.delete(dbUser.id);
      if (
        pendingTransition.tenantId === tenant.id &&
        pendingTransition.expiresAt > Date.now() &&
        CONFIRMATION.test(trimmed)
      ) {
        const confirmed: PracticeCommand = {
          type: 'CONFIRM_TRANSITION',
          payload: {
            practiceId: pendingTransition.practiceId,
            nextState: pendingTransition.nextState,
          },
        };
        const result = await deps.practiceService.executeCommand(
          confirmed,
          { tenantId: tenant.id, userId: dbUser.id, role: dbUser.role },
          { channel: this.channel.name },
        );
        await reply(formatPracticeCommandResult(result));
        return;
      }
      if (CONFIRMATION.test(trimmed)) {
        await reply('⌛ La richiesta è scaduta: ripeti il comando.');
        return;
      }
      await reply('Ok, operazione annullata.');
      if (!parsePracticeCommand(trimmed) && !parseComplianceCommand(trimmed)) return;
    }

    // A command suggested after a typing error, waiting for «sì»; any other message drops it.
    const pendingSuggestion = this.pendingSuggestions.get(dbUser.id);
    if (pendingSuggestion) {
      this.pendingSuggestions.delete(dbUser.id);
      if (CONFIRMATION.test(trimmed)) {
        if (pendingSuggestion.tenantId !== tenant.id || pendingSuggestion.expiresAt <= Date.now()) {
          await reply('⌛ La richiesta è scaduta: ripeti il comando.');
          return;
        }
        await this.process(
          { senderId: message.senderId, text: pendingSuggestion.text },
          reply,
          requestId,
        );
        return;
      }
    }

    // Typing errors in a command: a certain one on a read-only command is corrected at once,
    // anything else is asked first. Never applied to sentences, which go to the AI.
    const suggestion = suggestCommand(trimmed, (candidate) => this.isCommand(candidate));
    if (suggestion) {
      if (suggestion.readOnly && suggestion.distance === 1) {
        await reply(`🔎 Ho inteso «${suggestion.phrase}».`);
        await this.process(
          { senderId: message.senderId, text: suggestion.corrected },
          reply,
          requestId,
        );
        return;
      }
      this.pendingSuggestions.set(dbUser.id, {
        tenantId: tenant.id,
        text: suggestion.corrected,
        expiresAt: Date.now() + TRANSITION_CONFIRMATION_MS,
      });
      await reply(
        `❓ Intendevi «${suggestion.corrected}»? Rispondi «sì» per eseguirlo, ` +
          'oppure scrivi di nuovo la richiesta.',
      );
      return;
    }

    const scheduledExport = SCHEDULED_EXPORT_COMMAND.exec(trimmed);
    if (scheduledExport && deps.scheduledExport) {
      const enabled = scheduledExport[1].toLowerCase() === 'attiva';
      try {
        const changed = await deps.scheduledExport(tenant.id, dbUser.id, enabled);
        await reply(
          enabled
            ? changed
              ? "✅ Riceverai qui l'export pianificato delle pratiche dell'azienda.\n" +
                '⚠️ Il file resterà nella cronologia di questa chat e sul telefono. ' +
                'Per smettere scrivi «disattiva export pianificato».'
              : "Ricevi già l'export pianificato."
            : changed
              ? "Ok, non riceverai più l'export pianificato."
              : "Non ricevevi l'export pianificato.",
        );
      } catch (err: unknown) {
        if (!(err instanceof MemberAccessError)) throw err;
        await reply("🔒 Solo gli amministratori possono ricevere l'export pianificato.");
      }
      return;
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
      // C2: the caller's own practices by default; the organization only with explicit commands.
      const result = await deps.practiceService.executeCommand(
        command,
        { tenantId: tenant.id, userId: dbUser.id, role: dbUser.role },
        { channel: this.channel.name },
      );
      if (result.type === 'confirm_transition') {
        this.pendingTransitions.set(dbUser.id, {
          tenantId: tenant.id,
          practiceId: result.practice.id,
          nextState: result.nextState,
          expiresAt: Date.now() + TRANSITION_CONFIRMATION_MS,
        });
      }
      await reply(formatPracticeCommandResult(result));
      return;
    }

    if (lower === '/devstate' || lower === '/devreset') {
      if (process.env.NODE_ENV !== 'development') return;
      await runtimeAwareExecute({ reply }, async () => {
        if (lower === '/devreset') {
          await this.memory.reset(dbUser.id);
          await reply('🧹 Dev state reset complete.');
          return;
        }
        await handleDevState({ reply: async (runtimeReport) => void (await reply(runtimeReport)) });
      });
      return;
    }

    if (lower.startsWith('/start') || isGreeting(text)) {
      const firstTime = await this.memory.markOnboarded(tenant.id, dbUser.id);
      await reply(
        firstTime ? onboardingMessage(dbUser.role) : '👋 Bentornato! Come posso aiutarti?',
      );
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
