import { readPracticePayload } from '../practice/practice.payload.js';

import { chatDeliveriesTo } from './outbox.recipients.js';

import type { OutboxChannels, OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';
import type { PracticeState } from '../types/workflow.types.js';

/** A3: someone else changed the state of a person's practice. */
export const PRACTICE_STATUS_CHANGED = 'PRACTICE_STATUS_CHANGED';

export type PracticeStatusChangedPayload = {
  practiceId: string;
  /** The owner of the practice, the only one who receives the notice. */
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
      select: { payload: true, userId: true },
    });
    if (!practice || practice.userId !== payload.userId) return [];
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
