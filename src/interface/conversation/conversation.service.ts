import { permits } from '../../core/authz/authorization.service.js';
import { parseComplianceCommand } from '../../core/compliance/compliance.commands.js';
import {
  AttachmentRejectedError,
  DuplicateAttachmentError,
} from '../../core/errors/attachment.errors.js';
import { featureEnabled, type Feature } from '../../core/features/features.js';
import { MemberAccessError } from '../../core/identity/member-access.service.js';
import {
  OrganizationChoiceRequiredError,
  type MembershipOption,
} from '../../core/identity/membership.service.js';
import {
  parsePracticeCommand,
  type PracticeCommand,
} from '../../core/practice/practice.commands.js';
import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { getModule } from '../../modules/registry.js';
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
  PENDING_FILE_TTL_MS,
  readPendingFile,
  resolveAttachmentTarget,
  type AttachmentCandidate,
  type PendingFile,
} from '../telegram/telegram.attachment-target.js';
import { mapTelegramErrorToMessage } from '../telegram/telegram.errors.js';
import { runtimeAwareExecute } from '../telegram/telegram.runtimeAware.js';

import { suggestCommand } from './command.typos.js';
import { InMemoryConversationMemory, type ConversationMemory } from './conversation.memory.js';

import type { Principal } from '../../core/authz/authorization.service.js';
import type { CustomPermissions } from '../../core/authz/permissions.js';
import type { ComplianceService } from '../../core/compliance/compliance.service.js';
import type { CompanyCard } from '../../core/organization/company-card.service.js';
import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';
import type { Tenant } from '../../core/tenant/tenant.store.js';
import type { PracticeState } from '../../core/types/workflow.types.js';
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
  /** B2: the custom role of the membership, or null (the base role). */
  customPermissions: CustomPermissions | null;
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
  /**
   * AGX-01: the channel's id of the file (Telegram file_id, WhatsApp media id), to download it
   * again after a restart while the person still has to answer.
   */
  ref?: string;
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
  resolve(senderId: string): Promise<{
    tenant: Tenant;
    userId: string;
    role: UserRole;
    customPermissions: CustomPermissions | null;
  }>;
  /** Loads an organization chosen among the memberships of an OrganizationChoiceRequiredError. */
  tenantFor?(tenantId: string): Promise<Tenant>;
}

/** A reply of the AI; `clarification` when it asked something instead of acting. */
export type ChatAnswer = {
  text: string;
  clarification?: { options: string[] };
  /** S02: a change of state the AI proposes; the chat asks «sì» before doing it. */
  confirmTransition?: { practiceId: string; nextState: PracticeState };
};

export type ConversationDeps = {
  practiceService: Pick<PracticeApplicationService, 'executeCommand'> & {
    addAttachment?: PracticeApplicationService['addAttachment'];
    getMaxAttachmentBytes?: PracticeApplicationService['getMaxAttachmentBytes'];
    listPractices?: PracticeApplicationService['listPractices'];
  };
  complianceService?: Pick<ComplianceService, 'listDeadlines' | 'createDeadline' | 'closeDeadline'>;
  /** The AI for free text; a ChatAnswer also says when it asked a question back. */
  handleMessage: (input: string, identity: ConversationIdentity) => Promise<string | ChatAnswer>;
  /**
   * A1: confirms the data read from one of the person's documents as they are (corrections are
   * made in the dashboard).
   */
  confirmDocument?: (input: {
    tenantId: string;
    userId: string;
    practiceId: string;
    attachmentId: string;
  }) => Promise<void>;
  /**
   * H10: «parla con un operatore» records a request for the dashboard; `created: false` when the
   * person already has one still to be handled.
   */
  requestAssistance?: (input: {
    tenantId: string;
    userId: string;
    topic: AssistanceTopicChoice;
    channel: 'TELEGRAM' | 'WHATSAPP';
  }) => Promise<{ created: boolean; createdAt: Date }>;
  /** Turns the scheduled export in chat on or off for the person (D5b); returns whether it changed. */
  scheduledExport?: (orgId: string, userId: string, enabled: boolean) => Promise<boolean>;
  /** AGX-12a: the card of the company («🏢 La mia azienda»), within the person's grants. */
  companyCard?: (actor: Principal) => Promise<CompanyCard>;
  /** AGX-12a: the full codes, for who manages the organization only (null otherwise); audited. */
  revealCompanyIdentifiers?: (
    actor: Principal,
    channel: string,
  ) => Promise<{ taxCode: string | null; vatNumber: string | null } | null>;
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
  /** Address of the dashboard page of the documents to verify, for «Modifica» (A2). */
  reviewUrl?: string;
  /** AGX-01: downloads a file again from its `ref`, for a file waiting across a restart. */
  downloadRef?: (ref: string) => () => Promise<Buffer>;
};

/** A button under a reply: pressing it is the same as writing `answer` (A2). */
export type ReplyButton = { label: string; answer: string };

export type ReplyOptions = {
  /** Buttons under the message (Telegram); other channels show the text only. */
  buttons?: ReplyButton[];
  /** Shows the main menu at the bottom of the chat. */
  menu?: boolean;
};

type Reply = (text: string, options?: ReplyOptions) => Promise<unknown>;

/** The main menu of the chat (A2): each entry is a command already understood by the bot. */
export const MENU_BUTTONS: ReplyButton[] = [
  { label: '📁 Le mie pratiche', answer: 'lista pratiche' },
  { label: '⏰ Le mie scadenze', answer: 'scadenze' },
  { label: '🙋 Operatore', answer: 'operatore' },
  { label: '🏢 La mia azienda', answer: 'la mia azienda' },
  { label: '❓ Aiuto', answer: 'aiuto' },
];

export type AssistanceTopicChoice = 'PRACTICE' | 'DOCUMENT' | 'DEADLINE' | 'OTHER';

/** «Parla con un operatore» (H10), also from the menu. */
const ASSISTANCE_COMMAND = /^(?:\/?operatore|parla con (?:un )?operatore|assistenza)[.!]?$/i;

/** The topics of a request, in the order of the buttons; a number or the word chooses one. */
const ASSISTANCE_TOPICS: Array<{ topic: AssistanceTopicChoice; label: string; word: RegExp }> = [
  { topic: 'PRACTICE', label: '📁 Una pratica', word: /pratic/ },
  { topic: 'DOCUMENT', label: '📄 Un documento', word: /document/ },
  { topic: 'DEADLINE', label: '⏰ Una scadenza', word: /scadenz/ },
  { topic: 'OTHER', label: '💬 Altro', word: /altro/ },
];

function parseAssistanceTopic(text: string): AssistanceTopicChoice | 'cancel' | null {
  const t = text.trim().toLowerCase();
  if (/^annull/.test(t)) return 'cancel';
  const byNumber = /^[1-4]$/.test(t) ? ASSISTANCE_TOPICS[Number(t) - 1] : undefined;
  if (byNumber) return byNumber.topic;
  if (t.split(/\s+/).length > 3) return null;
  return ASSISTANCE_TOPICS.find((o) => o.word.test(t))?.topic ?? null;
}

const YES_NO: ReplyButton[] = [
  { label: 'Sì', answer: 'sì' },
  { label: 'No', answer: 'no' },
];

/** Telegram limits the text of a button; longer options are cut, the answer stays whole. */
function buttonLabel(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

// Most recent practices considered when choosing where a received file goes.
const ATTACHMENT_PRACTICE_LOOKUP_LIMIT = 20;

// A transition of someone else's practice waits this long for the person's confirmation (C2).
const TRANSITION_CONFIRMATION_MS = 5 * 60_000;
/** How long the question of the AI waits for its answer. */
const CLARIFICATION_MS = 10 * 60_000;
/** An answer to a question of the AI is short: a name, a few words. */
const MAX_ANSWER_LENGTH = 80;
const MAX_ANSWER_WORDS = 10;

function normalizedOption(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const CONFIRMATION = /^(s[iì]|conferm[ao])[.!]?$/i;

function formatDay(date: Date): string {
  return date.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
}

type PendingTransition = {
  tenantId: string;
  practiceId: string;
  /** S05: a deletion waiting for «sì»; otherwise a transition to `nextState`. */
  kind?: 'transition' | 'delete';
  nextState?: PracticeState;
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
const CARD_COMMAND =
  /^(?:la mia azienda|scheda(?: dell')?(?: ?azienda)?|dati (?:della mia |dell')?azienda)[.!?]?$/i;
const REVEAL_COMMAND = /^mostra (?:i )?codici(?: per intero)?$/i;

const TYPE_LABELS: Record<CompanyCard['type'], string> = {
  COMPANY: 'Azienda',
  COOPERATIVE: 'Cooperativa',
  NETWORK: "Rete d'impresa",
  CONSORTIUM: 'Consorzio',
  TRADE_ASSOCIATION: 'Associazione di categoria',
  ASSOCIATION: 'Associazione',
  PROFESSIONAL_FIRM: 'Studio professionale',
  OTHER: 'Altro',
};

function daysText(daysLeft: number): string {
  if (daysLeft === 0) return 'oggi';
  if (daysLeft === 1) return 'domani';
  if (daysLeft > 0) return `tra ${daysLeft} giorni`;
  return daysLeft === -1 ? 'scaduta ieri' : `scaduta da ${-daysLeft} giorni`;
}

/** AGX-12a: the card in chat; the codes, when present, are already masked. */
export function formatCompanyCard(card: CompanyCard, role: UserRole): string {
  const lines = [`🏢 Lavori per ${card.name} come ${ROLE_LABELS[role]}.`, ''];
  lines.push(`Tipo: ${TYPE_LABELS[card.type]}`);
  if (card.municipality) lines.push(`Comune: ${card.municipality}`);
  if (card.sector) lines.push(`Settore: ${card.sector}`);
  if (card.networks.length > 0) lines.push(`Reti: ${card.networks.join(', ')}`);
  if (card.openPractices !== null) lines.push(`📁 Pratiche aperte: ${card.openPractices}`);
  if (card.nextDeadline) {
    const d = card.nextDeadline;
    const [y, m, day] = d.dueDate.split('-');
    lines.push(`⏰ Prossima scadenza: ${d.title}, ${day}/${m}/${y} (${daysText(d.daysLeft)})`);
  }
  if (card.identifiers) {
    lines.push('');
    lines.push(`Codice fiscale / CUAA: ${card.identifiers.taxCode ?? 'non inserito'}`);
    lines.push(`Partita IVA: ${card.identifiers.vatNumber ?? 'non inserita'}`);
  }
  return lines.join('\n');
}

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

export function onboardingMessage(
  who: UserRole | { role: UserRole; customPermissions: CustomPermissions | null },
): string {
  const person = typeof who === 'string' ? { role: who, customPermissions: null } : who;
  if (permits(person, 'practice.transition')) {
    return `👋 Ciao! Ti aiuto a gestire le pratiche.

Puoi:
• validarle
• completarle
• controllarne lo stato
• gestire le scadenze (DURC, sicurezza, bio, visite mediche, patentini)
• chiedere aiuto a un operatore (scrivi "operatore")
• vedere i dati della tua azienda (scrivi "la mia azienda")

Prova a scrivere:
"valida la pratica di Mario Rossi"
"scadenze" oppure "nuova scadenza durc 31/12/2026 DURC annuale"`;
  }

  return `👋 Ciao! Ti aiuto a gestire le tue pratiche.

Puoi:
• creare una pratica
• controllare lo stato
• chiedere aggiornamenti
• vedere le tue scadenze (scrivi "scadenze")
• parlare con un operatore (scrivi "operatore")
• vedere i dati della tua azienda (scrivi "la mia azienda")

Prova a scrivere:
"crea pratica per Mario Rossi"`;
}

export class ConversationService {
  // AGX-01: the files waiting for an answer, with their download, in this process; what survives
  // a restart is the record in the conversation memory (see pendingFileOf).
  private readonly liveFiles = new Map<string, InboundFile>();
  // Transitions of practices of others waiting for «sì», by person (C2).
  private readonly pendingTransitions = new Map<string, PendingTransition>();
  // Commands suggested after a typing error, waiting for «sì», by person.
  private readonly pendingSuggestions = new Map<
    string,
    { tenantId: string; text: string; expiresAt: number }
  >();
  // A1: documents just read with doubts, waiting for «conferma» from the person who sent them.
  private readonly pendingDocuments = new Map<
    string,
    { tenantId: string; practiceId: string; attachmentId: string; expiresAt: number }
  >();
  // The request the AI answered with a question, by person: a short reply completes it
  // («crea nuova pratica» → «come si chiama?» → «Scontrino 001»), instead of starting over.
  private readonly pendingClarifications = new Map<
    string,
    { tenantId: string; request: string; options: string[]; expiresAt: number }
  >();
  // H10: «operatore» asked, waiting for the topic of the request.
  private readonly pendingAssistance = new Map<string, { tenantId: string; expiresAt: number }>();

  /** Whether a text is a command this channel handles without the AI. */
  private isCommand(text: string): boolean {
    return (
      (Boolean(this.deps.scheduledExport) && SCHEDULED_EXPORT_COMMAND.test(text)) ||
      (Boolean(this.deps.complianceService) && parseComplianceCommand(text) !== null) ||
      parsePracticeCommand(text) !== null
    );
  }
  private readonly memory: ConversationMemory;

  /** AGX-01: keeps a file waiting for the person's answer, in this process and in the memory. */
  private async savePendingFile(
    tenantId: string,
    userId: string,
    file: InboundFile,
    record: Omit<PendingFile, 'channel' | 'tenantId' | 'file' | 'expiresAt'>,
  ): Promise<void> {
    this.liveFiles.set(userId, file);
    const stored: PendingFile = {
      ...record,
      channel: this.channel.name,
      tenantId,
      file: {
        ref: file.ref,
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        hint: file.hint,
        compressedPhoto: file.compressedPhoto,
      },
      expiresAt: Date.now() + PENDING_FILE_TTL_MS,
    };
    await this.memory.setPendingFile(tenantId, userId, stored);
  }

  private async clearPendingFile(tenantId: string, userId: string): Promise<void> {
    this.liveFiles.delete(userId);
    await this.memory.setPendingFile(tenantId, userId, null);
  }

  /**
   * The file waiting for this person in this organization and channel, with a way to download it:
   * from this process, or again from the channel after a restart. `lost` when the record is there
   * but the file can no longer be downloaded (the person sends it again).
   */
  private async pendingFileOf(
    tenantId: string,
    userId: string,
  ): Promise<{ record: PendingFile; file: InboundFile } | 'lost' | null> {
    const record = readPendingFile(await this.memory.getPendingFile(userId));
    if (!record || record.channel !== this.channel.name) return null;
    if (record.tenantId !== tenantId || record.expiresAt <= Date.now()) {
      await this.clearPendingFile(tenantId, userId);
      return null;
    }
    const live = this.liveFiles.get(userId);
    if (live) return { record, file: live };
    if (record.file.ref && this.channel.downloadRef) {
      return {
        record,
        file: { ...record.file, download: this.channel.downloadRef(record.file.ref) },
      };
    }
    await this.clearPendingFile(tenantId, userId);
    return 'lost';
  }

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
      customPermissions: current.customPermissions,
    };
  }

  private async process(message: InboundMessage, reply: Reply, requestId: string): Promise<void> {
    const { deps } = this;
    const menuEntry = MENU_BUTTONS.find((b) => b.label === message.text.trim());
    const text = menuEntry ? menuEntry.answer : message.text;
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
      // A02: the welcome of the organization's module.
      const linked = await this.channel.identity.tenantFor?.(tenantId).catch(() => null);
      await reply(getModule(linked?.module).welcome);
      return;
    }

    const orgCommand = ORG_COMMAND.exec(trimmed);
    let identity: Awaited<ReturnType<ChannelIdentityProvider['resolve']>>;
    try {
      identity = await this.channel.identity.resolve(message.senderId);
      // AGX-12a: with the card available, «azienda» shows it (below, once the actor is known).
      if (orgCommand && !deps.companyCard) {
        await reply(`🏢 Lavori per ${identity.tenant.name}.`);
        return;
      }
    } catch (err: unknown) {
      if (err instanceof TenantNotLinkedError) {
        await reply(
          'Il tuo account non è ancora collegato a nessuna organizzazione.\nScrivi `start <codice invito>`.',
        );
        return;
      }
      if (!(err instanceof OrganizationChoiceRequiredError)) throw err;
      const chosen = await this.chooseOrganization(err, orgCommand, reply);
      if (!chosen) return;
      identity = chosen;
    }

    const tenant = identity.tenant;
    const dbUser = {
      id: identity.userId,
      role: identity.role,
      customPermissions: identity.customPermissions,
    };
    // A03 and B2: who acts, with the functions the platform turned off for the organization and
    // the custom role of the membership.
    const actor = {
      tenantId: tenant.id,
      userId: dbUser.id,
      role: dbUser.role,
      disabledFeatures: tenant.disabledFeatures,
      customPermissions: dbUser.customPermissions,
    };
    const featureOn = (feature: Feature) => featureEnabled(tenant.disabledFeatures, feature);
    const FEATURE_OFF = 'ℹ️ Questa funzione non è attiva per la tua organizzazione.';

    // AGX-12a: the card of the company, read only and without the AI.
    if ((orgCommand || CARD_COMMAND.test(trimmed)) && deps.companyCard) {
      const card = await deps.companyCard(actor);
      const masked = card.identifiers;
      const canReveal =
        Boolean(deps.revealCompanyIdentifiers) &&
        masked !== null &&
        (masked.taxCode !== null || masked.vatNumber !== null);
      await reply(
        formatCompanyCard(card, dbUser.role),
        canReveal
          ? { buttons: [{ label: '🔓 Mostra per intero', answer: 'mostra codici' }] }
          : undefined,
      );
      return;
    }
    if (REVEAL_COMMAND.test(trimmed) && deps.revealCompanyIdentifiers) {
      const codes = await deps.revealCompanyIdentifiers(actor, this.channel.name);
      if (!codes) {
        await reply('🔒 Solo gli amministratori vedono codice fiscale e partita IVA.');
        return;
      }
      await reply(
        `Codice fiscale / CUAA: ${codes.taxCode ?? 'non inserito'}\n` +
          `Partita IVA: ${codes.vatNumber ?? 'non inserita'}\n\n` +
          'Per modificarli usa Impostazioni nella dashboard.',
      );
      return;
    }

    // Downloads the file and attaches it to the chosen practice (OCR included).
    const uploadToPractice = async (
      file: InboundFile,
      practice: AttachmentCandidate,
      allowDuplicate = false,
    ) => {
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
          allowDuplicate,
          channel: this.channel.name,
        });
        await this.memory.setLastPractice(tenant.id, dbUser.id, practice.id);

        // Read with doubts: the person can confirm the data at once (A1, H9).
        const askConfirmation =
          Boolean(deps.confirmDocument) &&
          uploadResult.attachment.ocrStatus === 'COMPLETED' &&
          uploadResult.ocrResult?.reviewRequired === true;
        if (askConfirmation) {
          this.pendingDocuments.set(dbUser.id, {
            tenantId: tenant.id,
            practiceId: practice.id,
            attachmentId: uploadResult.attachment.id,
            expiresAt: Date.now() + CLARIFICATION_MS,
          });
        }
        await reply(
          `📁 Pratica: ${practice.name}\n` +
            formatAttachmentResult(uploadResult.attachment.ocrStatus, uploadResult.ocrResult) +
            (askConfirmation
              ? '\nSe i dati sono giusti rispondi «conferma»; per correggerli usa la dashboard ' +
                '(«Da verificare»).'
              : '') +
            (file.compressedPhoto && uploadResult.ocrResult?.reviewRequired
              ? (this.channel.compressedPhotoTip ?? '')
              : ''),
          askConfirmation
            ? {
                buttons: [
                  { label: '✅ Conferma', answer: 'conferma' },
                  { label: '✏️ Modifica', answer: 'modifica' },
                ],
              }
            : undefined,
        );
      } catch (uploadErr) {
        if (uploadErr instanceof AttachmentRejectedError) {
          await reply(formatAttachmentRejection(uploadErr));
          return;
        }
        // AGX-01: the same file again; sent only if the person says so.
        if (uploadErr instanceof DuplicateAttachmentError) {
          await this.savePendingFile(tenant.id, dbUser.id, file, {
            stage: 'duplicate',
            candidates: [],
            suggested: false,
            practice,
          });
          await reply(
            `⚠️ ${uploadErr.message}\nLo carico di nuovo nella pratica «${practice.name}»?`,
            { buttons: YES_NO },
          );
          return;
        }
        deps.log?.error({ error: errorLabel(uploadErr), requestId }, 'Attachment upload error');
        await reply(
          "⚠️ Si è verificato un errore durante l'acquisizione del documento. Riprova più tardi.",
        );
      }
    };

    if (message.file) {
      if (!featureOn('documents')) {
        await reply(FEATURE_OFF);
        return;
      }
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
      // AGX-01: always asked, even when only one practice is possible.
      await this.savePendingFile(tenant.id, dbUser.id, file, {
        stage: 'choose',
        candidates: target.candidates,
        suggested: target.suggested,
      });
      await reply(formatAttachmentQuestion(target.candidates, target.suggested), {
        buttons: [
          ...target.candidates.map((c, i) => ({
            label:
              target.suggested && i === 0 ? `✅ Sì, ${buttonLabel(c.name)}` : buttonLabel(c.name),
            answer: String(i + 1),
          })),
          { label: 'Annulla', answer: 'annulla' },
        ],
      });
      return;
    }

    const pending = await this.pendingFileOf(tenant.id, dbUser.id);
    if (pending === 'lost') {
      await reply('⌛ Non riesco più a recuperare il file che avevi inviato: mandalo di nuovo.');
      return;
    }
    if (pending?.record.stage === 'duplicate' && pending.record.practice) {
      await this.clearPendingFile(tenant.id, dbUser.id);
      if (CONFIRMATION.test(trimmed)) {
        await uploadToPractice(pending.file, pending.record.practice, true);
        return;
      }
      await reply('Ok, il file non è stato caricato di nuovo.');
      if (!this.isCommand(trimmed)) return;
    } else if (pending) {
      const { candidates, suggested } = pending.record;
      const selection = parseAttachmentSelection(trimmed, candidates.length, suggested);
      if (selection === 'cancel') {
        await this.clearPendingFile(tenant.id, dbUser.id);
        await reply('Ok, il file non è stato associato a nessuna pratica.');
        return;
      }
      const chosen = typeof selection === 'number' ? candidates[selection - 1] : null;
      if (chosen) {
        await this.clearPendingFile(tenant.id, dbUser.id);
        await uploadToPractice(pending.file, chosen);
        return;
      }
    }

    // The topic of a request to an operator; anything else drops the question and goes on.
    const pendingAssistance = this.pendingAssistance.get(dbUser.id);
    if (pendingAssistance) {
      this.pendingAssistance.delete(dbUser.id);
      const choice = parseAssistanceTopic(trimmed);
      if (choice === 'cancel') {
        await reply('Ok, nessuna richiesta inviata.');
        return;
      }
      if (
        choice &&
        deps.requestAssistance &&
        pendingAssistance.tenantId === tenant.id &&
        pendingAssistance.expiresAt > Date.now()
      ) {
        const result = await deps.requestAssistance({
          tenantId: tenant.id,
          userId: dbUser.id,
          topic: choice,
          channel: this.channel.name === 'telegram' ? 'TELEGRAM' : 'WHATSAPP',
        });
        await reply(
          result.created
            ? '✅ Richiesta inviata. Un operatore la vedrà nella dashboard e ti contatterà.'
            : `⏳ Hai già una richiesta di assistenza aperta dal ${formatDay(result.createdAt)}: ` +
                'un operatore ti contatterà.',
        );
        return;
      }
    }

    if (ASSISTANCE_COMMAND.test(trimmed) && deps.requestAssistance) {
      if (!featureOn('assistance')) {
        await reply(FEATURE_OFF);
        return;
      }
      if (!permits(dbUser, 'assistance.request')) {
        await reply('🔒 Non puoi inviare richieste di assistenza.');
        return;
      }
      this.pendingAssistance.set(dbUser.id, {
        tenantId: tenant.id,
        expiresAt: Date.now() + CLARIFICATION_MS,
      });
      await reply(
        '🙋 Su cosa ti serve aiuto? Scegli un argomento:\n' +
          ASSISTANCE_TOPICS.map((o, i) => `${i + 1}. ${o.label}`).join('\n') +
          '\n\nUn operatore vedrà la richiesta nella dashboard e ti contatterà.',
        {
          buttons: [
            ...ASSISTANCE_TOPICS.map((o) => ({ label: o.label, answer: o.label })),
            { label: 'Annulla', answer: 'annulla' },
          ],
        },
      );
      return;
    }

    // A document just read with doubts: «conferma» or «sì» confirms its data; anything else leaves
    // it to be verified later in the dashboard.
    const pendingDocument = this.pendingDocuments.get(dbUser.id);
    if (pendingDocument) {
      this.pendingDocuments.delete(dbUser.id);
      if (
        CONFIRMATION.test(trimmed) &&
        deps.confirmDocument &&
        pendingDocument.tenantId === tenant.id &&
        pendingDocument.expiresAt > Date.now()
      ) {
        await deps.confirmDocument({
          tenantId: tenant.id,
          userId: dbUser.id,
          practiceId: pendingDocument.practiceId,
          attachmentId: pendingDocument.attachmentId,
        });
        await reply('✅ Dati del documento confermati.');
        return;
      }
      if (/^modifica$/i.test(trimmed)) {
        await reply(
          '✏️ Puoi correggere i dati dalla dashboard, nella pagina «Da verificare»' +
            (this.channel.reviewUrl ? `:\n${this.channel.reviewUrl}` : '.'),
        );
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
        const confirmed: PracticeCommand =
          pendingTransition.kind === 'delete' || !pendingTransition.nextState
            ? { type: 'CONFIRM_DELETE', payload: { practiceId: pendingTransition.practiceId } }
            : {
                type: 'CONFIRM_TRANSITION',
                payload: {
                  practiceId: pendingTransition.practiceId,
                  nextState: pendingTransition.nextState,
                },
              };
        const result = await deps.practiceService.executeCommand(confirmed, actor, {
          channel: this.channel.name,
        });
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

    // The answer to a question of the AI completes the request it asked about. Commands, greetings,
    // a choice among the offered options and long sentences are new requests instead.
    const clarification = this.pendingClarifications.get(dbUser.id);
    if (clarification) {
      this.pendingClarifications.delete(dbUser.id);
      const isOption = clarification.options.some(
        (o) => normalizedOption(o) === normalizedOption(trimmed),
      );
      const isAnswer =
        clarification.tenantId === tenant.id &&
        clarification.expiresAt > Date.now() &&
        !isOption &&
        trimmed.length <= MAX_ANSWER_LENGTH &&
        trimmed.split(/\s+/).length <= MAX_ANSWER_WORDS &&
        !trimmed.startsWith('/') &&
        !CONFIRMATION.test(trimmed) &&
        !isGreeting(trimmed) &&
        !this.isCommand(trimmed) &&
        !suggestCommand(trimmed, (candidate) => this.isCommand(candidate));
      if (isAnswer) {
        await this.process(
          { senderId: message.senderId, text: `${clarification.request} ${trimmed}` },
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
        { buttons: YES_NO },
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
          disabledFeatures: tenant.disabledFeatures,
          customPermissions: dbUser.customPermissions,
        }),
      );
      return;
    }

    const command = parsePracticeCommand(trimmed);
    if (command) {
      // C2: the caller's own practices by default; the organization only with explicit commands.
      const result = await deps.practiceService.executeCommand(command, actor, {
        channel: this.channel.name,
      });
      if (result.type === 'confirm_transition') {
        this.pendingTransitions.set(dbUser.id, {
          tenantId: tenant.id,
          practiceId: result.practice.id,
          kind: 'transition',
          nextState: result.nextState,
          expiresAt: Date.now() + TRANSITION_CONFIRMATION_MS,
        });
      }
      if (result.type === 'confirm_delete') {
        this.pendingTransitions.set(dbUser.id, {
          tenantId: tenant.id,
          practiceId: result.practice.id,
          kind: 'delete',
          expiresAt: Date.now() + TRANSITION_CONFIRMATION_MS,
        });
      }
      await reply(
        formatPracticeCommandResult(result),
        result.type === 'confirm_transition' || result.type === 'confirm_delete'
          ? { buttons: YES_NO }
          : undefined,
      );
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

    // «Aiuto» (also from the menu) always explains what the bot does.
    if (/^(aiuto|\/help)$/i.test(trimmed)) {
      await reply(onboardingMessage(dbUser), { menu: true });
      return;
    }

    if (lower.startsWith('/start') || isGreeting(text)) {
      const firstTime = await this.memory.markOnboarded(tenant.id, dbUser.id);
      await reply(firstTime ? onboardingMessage(dbUser) : '👋 Bentornato! Come posso aiutarti?', {
        menu: true,
      });
      return;
    }

    // Defensive layer: never let a slash command reach the AI pipeline.
    if (trimmed.startsWith('/')) {
      await reply(onboardingMessage(dbUser));
      return;
    }

    // A03: with the AI off, free text gets the list of commands instead of an interpretation.
    if (!featureOn('ai_chat')) {
      await reply(
        `ℹ️ L'assistente IA non è attivo per la tua organizzazione: usa i comandi.\n\n${onboardingMessage(dbUser)}`,
        { menu: true },
      );
      return;
    }

    const raw = await deps.handleMessage(text, {
      tenantId: tenant.id,
      userId: dbUser.id,
      role: dbUser.role,
      customPermissions: dbUser.customPermissions,
    });
    const answer: ChatAnswer = typeof raw === 'string' ? { text: raw } : raw;
    // S02: a change of state proposed by the AI is done only after «sì».
    if (answer.confirmTransition) {
      this.pendingTransitions.set(dbUser.id, {
        tenantId: tenant.id,
        practiceId: answer.confirmTransition.practiceId,
        kind: 'transition',
        nextState: answer.confirmTransition.nextState,
        expiresAt: Date.now() + TRANSITION_CONFIRMATION_MS,
      });
      await reply(answer.text, { buttons: YES_NO });
      return;
    }
    if (answer.clarification) {
      this.pendingClarifications.set(dbUser.id, {
        tenantId: tenant.id,
        request: trimmed.slice(0, 300),
        options: answer.clarification.options,
        expiresAt: Date.now() + CLARIFICATION_MS,
      });
    }
    const options = answer.clarification?.options ?? [];
    await reply(
      answer.text,
      options.length > 0
        ? { buttons: options.map((o) => ({ label: buttonLabel(o), answer: o })) }
        : undefined,
    );
  }
}
