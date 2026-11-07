import { ATTACHMENT_REJECTED } from '../practice/document-checklist.js';
import { PRACTICE_ASSIGNED } from '../practice/practice-assignment.js';
import { PRACTICE_HOLDER_SET, practiceRecipient } from '../practice/practice-holder.js';
import { readPracticePayload } from '../practice/practice.payload.js';

import { chatDeliveriesTo } from './outbox.recipients.js';

import type { OutboxChannels, OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';
import type { AttachmentRejectedPayload } from '../practice/document-checklist.js';
import type { PracticeAssignedPayload } from '../practice/practice-assignment.js';
import type { PracticeHolderSetPayload } from '../practice/practice-holder.js';
import type { PracticeState } from '../types/workflow.types.js';

/** A3: someone else changed the state of a person's practice. */
export const PRACTICE_STATUS_CHANGED = 'PRACTICE_STATUS_CHANGED';

export type PracticeStatusChangedPayload = {
  practiceId: string;
  /** Who receives the notice: the holder of the practice, or its creator (AGX-03). */
  userId: string;
  from: PracticeState;
  to: PracticeState;
};

/** The chat notice for the owner; null for states that need none. */
export function formatPracticeStatusNotice(name: string, to: PracticeState): string | null {
  switch (to) {
    case 'VALIDATED':
      return `✅ La tua pratica «${name}» è stata validata.`;
    case 'SUBMITTED':
      return `📤 La tua pratica «${name}» è stata inviata.`;
    case 'COMPLETED':
      return `🎉 La tua pratica «${name}» è stata completata.`;
    case 'FAILED':
      return (
        `❌ La tua pratica «${name}» non è andata a buon fine.\n` +
        'Per chiarimenti scrivi «operatore».'
      );
    default:
      return null;
  }
}

/**
 * Sends the notice in chat to the owner of the practice only, through their active links. The name
 * is read at delivery time: a practice deleted in the meantime sends nothing.
 */
export class PracticeStatusHandler implements OutboxEventHandler {
  readonly eventType = PRACTICE_STATUS_CHANGED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as PracticeStatusChangedPayload;
    const practice = await this.prisma.practice.findFirst({
      where: { id: payload.practiceId, tenantId: message.tenantId },
      select: { payload: true, userId: true, holderUserId: true },
    });
    // Nothing if the practice changed hands meanwhile.
    if (!practice || practiceRecipient(practice) !== payload.userId) return [];
    const name = readPracticePayload(practice.payload).name ?? 'senza nome';
    const text = formatPracticeStatusNotice(name, payload.to);
    if (!text) return [];
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}

/**
 * A4: the administrator or operator who was given a practice hears it in chat, with the link to
 * it when the dashboard address is known. Nothing is sent if the practice moved on to someone else.
 */
export class PracticeAssignedHandler implements OutboxEventHandler {
  readonly eventType = PRACTICE_ASSIGNED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
    /** Base address of the dashboard (`…/app`), when known. */
    private readonly dashboardUrl?: string,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as PracticeAssignedPayload;
    const practice = await this.prisma.practice.findFirst({
      where: { id: payload.practiceId, tenantId: message.tenantId },
      select: { payload: true, assignedTo: true },
    });
    if (!practice || practice.assignedTo !== payload.userId) return [];
    const name = readPracticePayload(practice.payload).name ?? 'senza nome';
    const text =
      `📌 Ti è stata assegnata la pratica «${name}».` +
      (this.dashboardUrl ? `\n${this.dashboardUrl}/pratiche/${payload.practiceId}` : '');
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}

/**
 * AGX-03: the person a practice was opened for hears it in chat, with the link to it when the
 * dashboard address is known. Nothing is sent if the practice moved on to someone else.
 */
export class PracticeHolderSetHandler implements OutboxEventHandler {
  readonly eventType = PRACTICE_HOLDER_SET;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
    /** Base address of the dashboard (`…/app`), when known. */
    private readonly dashboardUrl?: string,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as PracticeHolderSetPayload;
    const practice = await this.prisma.practice.findFirst({
      where: { id: payload.practiceId, tenantId: message.tenantId },
      select: { payload: true, holderUserId: true },
    });
    if (!practice || practice.holderUserId !== payload.userId) return [];
    const name = readPracticePayload(practice.payload).name ?? 'senza nome';
    const text =
      `📂 È stata aperta per te la pratica «${name}».\n` +
      'Puoi mandarmi qui i documenti: ti chiederò sempre a quale pratica allegarli.' +
      (this.dashboardUrl ? `\n${this.dashboardUrl}/pratiche/${payload.practiceId}` : '');
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}

/**
 * AGX-05: whoever the practice belongs to hears that a document was rejected, with the reason, so
 * they can send a new one. Nothing is sent if the file was confirmed or removed meanwhile, or the
 * practice changed hands.
 */
export class AttachmentRejectedHandler implements OutboxEventHandler {
  readonly eventType = ATTACHMENT_REJECTED;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as AttachmentRejectedPayload;
    const file = await this.prisma.practiceAttachment.findFirst({
      where: { id: payload.attachmentId, tenantId: message.tenantId },
      select: {
        fileName: true,
        rejectedAt: true,
        rejectionReason: true,
        practice: { select: { payload: true, userId: true, holderUserId: true } },
      },
    });
    if (!file?.rejectedAt || practiceRecipient(file.practice) !== payload.userId) return [];
    const name = readPracticePayload(file.practice.payload).name ?? 'senza nome';
    const text =
      `❌ Il documento «${file.fileName}» della pratica «${name}» non è stato accettato.\n` +
      (file.rejectionReason ? `Motivo: ${file.rejectionReason}\n` : '') +
      'Mandane uno nuovo qui in chat: ti chiederò a quale pratica allegarlo.';
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}
