import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import {
  ATTACHMENT_OCR,
  ATTACHMENT_READ,
  CHAT_CHANNELS,
  payloadWithReadAttachment,
} from '../practice/attachment-ocr.js';
import { practiceRecipient } from '../practice/practice-holder.js';
import { readPracticePayload } from '../practice/practice.payload.js';
import { attachmentUsage, recordUsage } from '../usage/usage.service.js';

import { chatDeliveriesTo } from './outbox.recipients.js';

import type { OutboxChannels, OutboxDelivery, OutboxEventHandler } from './outbox.delivery.js';
import type { DocumentOcrService } from '../../ai/ocr/document-ocr.service.js';
import type { DocumentOcrResult } from '../../ai/ocr/ocr.types.js';
import type { ClaimedOutboxMessage } from '../../data/repositories/outbox.repository.js';
import type { StorageService } from '../../data/storage/storage.service.js';
import type { PrismaTx } from '../../data/types/prisma.js';
import type { AttachmentOcrPayload, AttachmentReadPayload } from '../practice/attachment-ocr.js';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * AGX-08: reads again, in the background, a file whose read failed on upload. A failure is thrown,
 * so the dispatcher retries it with backoff; the last allowed attempt marks the file `FAILED`
 * (manual check) instead. Only a file still `PENDING` is changed, so a repeated delivery of the
 * same job does nothing twice.
 */
export class AttachmentOcrHandler implements OutboxEventHandler {
  readonly eventType = ATTACHMENT_OCR;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: {
      ocrService: Pick<DocumentOcrService, 'processDocument'>;
      storageService: Pick<StorageService, 'read'>;
      /** Attempts in the background, at most the outbox's own limit. */
      maxAttempts: number;
    },
  ) {}

  resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    return Promise.resolve([{ target: 'ocr', send: () => this.read(message) }]);
  }

  private async read(message: ClaimedOutboxMessage): Promise<void> {
    const payload = message.payload as AttachmentOcrPayload;
    const file = await this.prisma.practiceAttachment.findFirst({
      where: { id: payload.attachmentId, tenantId: message.tenantId },
      select: {
        id: true,
        practiceId: true,
        fileName: true,
        mimeType: true,
        storagePath: true,
        ocrStatus: true,
        createdAt: true,
      },
    });
    // Deleted, or already read (a repeated delivery): nothing to do.
    if (file?.ocrStatus !== 'PENDING') return;

    let result: DocumentOcrResult;
    try {
      const content = await this.deps.storageService.read(message.tenantId, file.storagePath);
      result = await this.deps.ocrService.processDocument(content, file.mimeType, file.fileName);
    } catch (err: unknown) {
      if (message.attempts < this.deps.maxAttempts) throw err;
      await this.finish(message, payload, 'FAILED', null);
      return;
    }
    await this.finish(message, payload, 'COMPLETED', { file, result });
  }

  private async finish(
    message: ClaimedOutboxMessage,
    payload: AttachmentOcrPayload,
    outcome: 'COMPLETED' | 'FAILED',
    read: {
      file: { id: string; practiceId: string; fileName: string; mimeType: string; createdAt: Date };
      result: DocumentOcrResult;
    } | null,
  ): Promise<void> {
    await withTransaction(this.prisma, async (tx: PrismaTx) => {
      const changed = await tx.practiceAttachment.updateMany({
        where: { id: payload.attachmentId, tenantId: message.tenantId, ocrStatus: 'PENDING' },
        data: read
          ? {
              ocrStatus: 'COMPLETED',
              ocrResult: read.result as unknown as Prisma.InputJsonValue,
            }
          : { ocrStatus: 'FAILED' },
      });
      if (changed.count === 0) return;

      if (read) {
        const practice = await tx.practice.findFirst({
          where: { id: read.file.practiceId, tenantId: message.tenantId },
          select: { payload: true },
        });
        if (practice) {
          await tx.practice.updateMany({
            where: { id: read.file.practiceId, tenantId: message.tenantId },
            data: {
              payload: payloadWithReadAttachment(
                practice.payload,
                read.file,
                read.result,
              ) as unknown as Prisma.InputJsonValue,
            },
          });
        }
        // AGX-07: the pages read now (the upload counted the document, with no page).
        await recordUsage(
          tx,
          attachmentUsage(payload.attachmentId, read.result)
            .filter((u) => u.kind === 'OCR_PAGES')
            .map((u) => ({
              ...u,
              tenantId: message.tenantId,
              actorOrgId: payload.actorOrgId,
              userId: payload.userId,
              practiceId: payload.practiceId,
            })),
        );
      }

      await new AuditService(tx).logEvent({
        tenantId: message.tenantId,
        userId: null,
        eventType: read ? 'ATTACHMENT_READ_RETRIED' : 'ATTACHMENT_READ_FAILED',
        payload: {
          practiceId: payload.practiceId,
          attachmentId: payload.attachmentId,
          attempts: message.attempts,
          ...(read ? { documentType: read.result.documentType } : {}),
        },
      });

      if (payload.channel && CHAT_CHANNELS.includes(payload.channel)) {
        await new OutboxRepository(tx).createMessage({
          tenantId: message.tenantId,
          eventType: ATTACHMENT_READ,
          payload: {
            attachmentId: payload.attachmentId,
            userId: payload.userId,
            outcome,
          } satisfies AttachmentReadPayload,
        });
      }
    });
  }
}

/**
 * AGX-08: whoever sent the file from a chat hears how the background read ended: read (with a
 * warning when some data needs a check), or not readable and waiting for a person.
 */
export class AttachmentReadHandler implements OutboxEventHandler {
  readonly eventType = ATTACHMENT_READ;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly channels: OutboxChannels,
  ) {}

  async resolveDeliveries(message: ClaimedOutboxMessage): Promise<OutboxDelivery[]> {
    const payload = message.payload as AttachmentReadPayload;
    const file = await this.prisma.practiceAttachment.findFirst({
      where: { id: payload.attachmentId, tenantId: message.tenantId },
      select: {
        fileName: true,
        ocrResult: true,
        practice: { select: { payload: true, userId: true, holderUserId: true } },
      },
    });
    if (!file) return [];
    const name = readPracticePayload(file.practice.payload).name ?? 'senza nome';
    const reviewRequired =
      (file.ocrResult as { reviewRequired?: unknown } | null)?.reviewRequired === true;
    const text =
      payload.outcome === 'COMPLETED'
        ? `📄 Ho letto il documento «${file.fileName}» della pratica «${name}».` +
          (reviewRequired ? '\n⚠️ Alcuni dati vanno verificati: se ne occuperà un operatore.' : '')
        : `⚠️ Non sono riuscito a leggere il documento «${file.fileName}» della pratica ` +
          `«${name}»: verrà controllato manualmente. Il file è salvato, non devi rimandarlo.`;
    // Only to who sent it, and only while they can still see the practice.
    const reaches =
      payload.userId === file.practice.userId ||
      payload.userId === practiceRecipient(file.practice);
    if (!reaches) return [];
    return chatDeliveriesTo(
      this.prisma,
      message.tenantId,
      this.channels,
      (notifier, chatId) => notifier.sendMessage(chatId, text),
      { userIds: [payload.userId] },
    );
  }
}
