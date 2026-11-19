import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { chatDeliveriesTo } from '../outbox/outbox.recipients.js';

import { expectedDocumentsOf } from './document-checklist.js';
import { practiceRecipient } from './practice-holder.js';
import { readPracticePayload } from './practice.payload.js';

import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { PrismaLike } from '../../data/types/prisma.js';
import type {
  OutboxChannels,
  OutboxDelivery,
  OutboxEventHandler,
} from '../outbox/outbox.delivery.js';
import type { SchedulerTaskContext, SchedulerTaskHandler } from '../scheduler/scheduler.tasks.js';
import type { PrismaClient } from '@prisma/client';

/**
 * Reminders of the documents asked for with a date (AGX-06 follow-up): whoever must send the
 * document hears it in chat two days before the date and on the day itself (or the first day the
 * check runs after it), each once per request. Nothing is sent once the request is answered or
 * cancelled, or the practice is closed.
 */
export const DOCUMENT_REQUEST_DUE = 'DOCUMENT_REQUEST_DUE';

export type DocumentRequestDuePayload = {
  requestId: string;
  userId: string;
  /** `before`: the date is near; `due`: it is today or already past. */
  kind: 'before' | 'due';
};

/** Days before the date of the first reminder. */
export const REMINDER_DAYS_BEFORE = 2;

const DAY_MS = 24 * 60 * 60_000;

/** Today in Italy, as the UTC midnight of that day (how `@db.Date` columns are read). */
export function italianToday(now: Date): Date {
  const day = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  return new Date(`${day}T00:00:00Z`);
}

export class DocumentRequestDueTask implements SchedulerTaskHandler {
  readonly type = 'CHECK_DOCUMENT_REQUESTS_DUE' as const;

  constructor(private readonly prisma: PrismaClient) {}

  async run({ tenant, now }: SchedulerTaskContext): Promise<Record<string, unknown>> {
    const today = italianToday(now);
    const soon = new Date(today.getTime() + REMINDER_DAYS_BEFORE * DAY_MS);
    const requests = await this.prisma.documentRequest.findMany({
      where: {
        tenantId: tenant.id,
        status: 'OPEN',
        dueDate: { lte: soon },
        remindedDueAt: null,
        practice: { status: { notIn: ['COMPLETED', 'FAILED'] } },
      },
      select: {
        id: true,
        dueDate: true,
        remindedBeforeAt: true,
        practice: { select: { userId: true, holderUserId: true } },
      },
    });
    let enqueued = 0;
    for (const r of requests) {
      if (!r.dueDate) continue;
      const kind = r.dueDate <= today ? 'due' : 'before';
      if (kind === 'before' && r.remindedBeforeAt) continue;
      await withTransaction(this.prisma, async (tx) => {
        // Conditional: two schedulers at once enqueue it only once. The day's reminder also marks
        // the earlier one, so a date set close by gets only one.
        const marked = await tx.documentRequest.updateMany({
          where:
            kind === 'due'
              ? { id: r.id, status: 'OPEN', remindedDueAt: null }
              : { id: r.id, status: 'OPEN', remindedBeforeAt: null },
          data:
            kind === 'due'
              ? { remindedDueAt: now, remindedBeforeAt: r.remindedBeforeAt ?? now }
              : { remindedBeforeAt: now },
        });
        if (marked.count === 0) return;
        await new OutboxRepository(tx).createMessage({
          tenantId: tenant.id,
          eventType: DOCUMENT_REQUEST_DUE,
          payload: {
            requestId: r.id,
            userId: practiceRecipient(r.practice),
            kind,
          } satisfies DocumentRequestDuePayload,
        });
        enqueued++;
      });
    }
    return { checked: requests.length, enqueued };
  }
}

const shortDay = (date: Date) => date.toISOString().slice(0, 10).split('-').reverse().join('/');

export function dueReminderText(input: {
  practiceName: string;
  label: string | undefined;
  message: string;
  dueDate: Date;
  today: Date;
}): string {
  const days = Math.round((input.dueDate.getTime() - input.today.getTime()) / DAY_MS);
  const when =
    days > 1
      ? `entro il ${shortDay(input.dueDate)} (tra ${days} giorni)`
      : days === 1
        ? `entro domani, ${shortDay(input.dueDate)}`
        : days === 0
          ? 'entro oggi'
          : `entro il ${shortDay(input.dueDate)}: la data è passata`;
  return [
    `⏰ Promemoria: per la pratica «${input.practiceName}» serve ancora un documento${
      input.label ? `: ${input.label}` : ''
    }, ${when}.`,
    `«${input.message}»`,
    'Mandalo qui in chat: ti chiederò a quale pratica allegarlo. Se hai un problema scrivi «operatore».',
  ].join('\n');
}

/** Sends the reminder to whoever the practice belongs to, if the request is still open. */
export class DocumentRequestDueHandler implements OutboxEventHandler {
  readonly eventType = DOCUMENT_REQUEST_DUE;

  constructor(
    private readonly prisma: PrismaLike,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as DocumentRequestDuePayload;
    const request = await this.prisma.documentRequest.findFirst({
      where: { id: payload.requestId, tenantId: message.tenantId, status: 'OPEN' },
      select: {
        message: true,
        expectedKey: true,
        dueDate: true,
        practice: { select: { payload: true, status: true, userId: true, holderUserId: true } },
      },
    });
    if (
      !request?.dueDate ||
      request.practice.status === 'COMPLETED' ||
      request.practice.status === 'FAILED' ||
      practiceRecipient(request.practice) !== payload.userId
    ) {
      return [];
    }
    const text = dueReminderText({
      practiceName: readPracticePayload(request.practice.payload).name ?? 'senza nome',
      label: request.expectedKey
        ? expectedDocumentsOf(request.practice.payload).find((d) => d.key === request.expectedKey)
            ?.label
        : undefined,
      message: request.message,
      dueDate: request.dueDate,
      today: italianToday(new Date()),
    });
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}
