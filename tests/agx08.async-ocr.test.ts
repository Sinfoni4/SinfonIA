/**
 * AGX-08: a document whose first read fails is read again in the background (outbox job), with
 * retries; after the last allowed attempt it goes to the manual check. Whoever sent it from a
 * chat hears the outcome. A repeated delivery of the job changes nothing twice.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { defaultDocumentOcrService } from '../src/ai/ocr/document-ocr.service.js';
import {
  AttachmentOcrHandler,
  AttachmentReadHandler,
} from '../src/core/outbox/attachment-ocr.handler.js';
import {
  ATTACHMENT_OCR,
  ATTACHMENT_READ,
  payloadWithReadAttachment,
} from '../src/core/practice/attachment-ocr.js';
import { reviewQueueWhere } from '../src/core/practice/attachment-validation.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { defaultStorageService } from '../src/data/storage/storage.service.js';
import { formatAttachmentResult } from '../src/interface/telegram/attachment.formatter.js';

import type { DocumentOcrService } from '../src/ai/ocr/document-ocr.service.js';
import type { DocumentOcrResult } from '../src/ai/ocr/ocr.types.js';
import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

const READ: DocumentOcrResult = {
  documentType: 'generic',
  missingFields: [],
  warnings: [],
  reviewRequired: false,
  extraction: { source: 'ocr_image', pages: 1, ocrPages: 1, confidence: 91 },
} as unknown as DocumentOcrResult;

describe('background read helpers', () => {
  it('tells the person in chat that the file is saved and will be read again', () => {
    const text = formatAttachmentResult('PENDING', undefined);
    expect(text).toContain('Documento salvato');
    expect(text).toContain('riprovo tra poco');
    expect(text).not.toContain('controllato manualmente');
  });

  it('adds the read file to the practice once, replacing an older entry', () => {
    const file = { id: 'a', fileName: 'f.jpg', mimeType: 'image/jpeg', createdAt: new Date(0) };
    const once = payloadWithReadAttachment({ name: 'P', attachments: [{ id: 'b' }] }, file, READ);
    const twice = payloadWithReadAttachment(once, file, READ);
    expect((twice.attachments as Array<{ id: string }>).map((a) => a.id)).toEqual(['b', 'a']);
    expect(twice).toMatchObject({ name: 'P', lastOcrResult: { documentType: 'generic' } });
  });
});

describe.runIf(Boolean(DATABASE_URL))('reading a document again in the background (AGX-08)', () => {
  const run = randomUUID().slice(0, 8);
  const chatId = `97${run.replace(/\D/g, '1').slice(0, 6)}7`;
  let prisma: PrismaClient;
  let tenantId = '';
  let userId = '';
  let practiceId = '';
  const sent: Array<{ chatId: string; text: string }> = [];
  const telegram: ChatNotifier = {
    sendDocument: () => Promise.resolve(),
    sendMessage: (to, text) => {
      sent.push({ chatId: to, text });
      return Promise.resolve();
    },
  };
  // The real service, with a read that can be made to fail.
  const processDocument = vi.fn<DocumentOcrService['processDocument']>();
  const ocrService = Object.assign(Object.create(defaultDocumentOcrService) as DocumentOcrService, {
    processDocument,
  });
  const practices = () => new PracticeApplicationService(prisma, { ocrService });
  const handler = () =>
    new AttachmentOcrHandler(prisma, {
      ocrService,
      storageService: defaultStorageService,
      maxAttempts: 3,
    });

  const upload = async (channel: string, service = practices()) =>
    service.addAttachment({
      tenantId,
      userId,
      practiceId,
      fileName: `foto-${randomUUID().slice(0, 6)}.txt`,
      mimeType: 'text/plain',
      content: Buffer.from(`documento ${run} ${randomUUID()}`),
      channel,
    });
  const job = async (attachmentId: string, attempts: number): Promise<ClaimedOutboxMessage> => {
    const row = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        tenantId,
        eventType: ATTACHMENT_OCR,
        payload: { path: ['attachmentId'], equals: attachmentId },
      },
    });
    return {
      id: row.id,
      tenantId,
      eventType: row.eventType,
      payload: row.payload,
      attempts,
      claimToken: 'test',
      deliveredTargets: [],
      createdAt: row.createdAt,
    };
  };
  const runJob = async (message: ClaimedOutboxMessage) => {
    const [delivery] = await handler().resolveDeliveries(message);
    await delivery.send();
  };
  const notices = (attachmentId: string) =>
    prisma.outboxMessage.findMany({
      where: {
        tenantId,
        eventType: ATTACHMENT_READ,
        payload: { path: ['attachmentId'], equals: attachmentId },
      },
    });
  const fileOf = (id: string) => prisma.practiceAttachment.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (await new TenantRepository(prisma).createTenant({ name: `Azienda ${run}` })).id;
    userId = (
      await new UserRepository(prisma).createUser(tenantId, {
        email: `farmer-${run}@agx08.local`,
        role: 'MEMBER',
        telegramId: chatId,
      })
    ).id;
    practiceId = (
      await new PracticeApplicationService(prisma).createPractice({
        tenantId,
        userId,
        name: `Domanda PAC ${run}`,
      })
    ).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps the file waiting, not failed, when the first read fails', async () => {
    processDocument.mockRejectedValueOnce(new Error('OCR worker crashed'));
    const result = await upload('telegram');
    expect(result.attachment.ocrStatus).toBe('PENDING');
    expect(result.ocrResult).toBeUndefined();
    // Not in the manual check yet, and a job is waiting in the outbox.
    expect(
      await prisma.practiceAttachment.count({
        where: { id: result.attachment.id, ...reviewQueueWhere() },
      }),
    ).toBe(0);
    const message = await job(result.attachment.id, 1);
    expect(message.payload).toEqual({
      attachmentId: result.attachment.id,
      practiceId,
      userId,
      channel: 'telegram',
      actorOrgId: null,
    });
    // The upload counted the document, with no page read.
    const usage = await prisma.usageEvent.findMany({ where: { practiceId, tenantId } });
    expect(usage.map((u) => u.kind)).toContain('DOCUMENT_RECEIVED');
    expect(usage.map((u) => u.idempotencyKey)).not.toContain(`ocr.pages:${result.attachment.id}`);
  });

  it('reads it at a later attempt, enriches the practice and tells the sender once', async () => {
    processDocument.mockRejectedValueOnce(new Error('OCR worker crashed'));
    const { attachment } = await upload('telegram');

    // Attempt 1 fails: thrown, so the dispatcher retries it; nothing changes.
    processDocument.mockRejectedValueOnce(new Error('still down'));
    await expect(runJob(await job(attachment.id, 1))).rejects.toThrow('still down');
    expect((await fileOf(attachment.id)).ocrStatus).toBe('PENDING');

    // Attempt 2 succeeds.
    processDocument.mockResolvedValueOnce(READ);
    await runJob(await job(attachment.id, 2));
    const file = await fileOf(attachment.id);
    expect(file.ocrStatus).toBe('COMPLETED');
    expect(file.ocrResult).toMatchObject({ documentType: 'generic', reviewRequired: false });
    const practice = await prisma.practice.findUniqueOrThrow({ where: { id: practiceId } });
    expect(
      (practice.payload as { attachments: Array<{ id: string }> }).attachments.map((a) => a.id),
    ).toContain(attachment.id);
    const pages = await prisma.usageEvent.findUniqueOrThrow({
      where: { idempotencyKey: `ocr.pages:${attachment.id}` },
    });
    expect(pages).toMatchObject({ kind: 'OCR_PAGES', quantity: 1, userId });
    expect(
      await prisma.auditLog.count({
        where: {
          tenantId,
          eventType: 'ATTACHMENT_READ_RETRIED',
          payload: { path: ['attachmentId'], equals: attachment.id },
        },
      }),
    ).toBe(1);

    // A repeated delivery of the same job does nothing: no second read, notice or audit.
    const calls = processDocument.mock.calls.length;
    await runJob(await job(attachment.id, 3));
    expect(processDocument.mock.calls.length).toBe(calls);
    const [notice] = await notices(attachment.id);
    expect(await notices(attachment.id)).toHaveLength(1);
    expect(notice.payload).toMatchObject({ userId, outcome: 'COMPLETED' });

    sent.length = 0;
    const deliveries = await new AttachmentReadHandler(prisma, { telegram }).resolveDeliveries({
      ...(await job(attachment.id, 1)),
      id: notice.id,
      eventType: ATTACHMENT_READ,
      payload: notice.payload,
    });
    for (const d of deliveries) await d.send();
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(chatId);
    expect(sent[0].text).toContain(`Ho letto il documento «${attachment.fileName}»`);
    expect(sent[0].text).toContain(`Domanda PAC ${run}`);
  });

  it('sends it to the manual check after the last attempt, and says so in chat', async () => {
    processDocument.mockRejectedValue(new Error('unreadable'));
    const { attachment } = await upload('telegram');
    await expect(runJob(await job(attachment.id, 2))).rejects.toThrow('unreadable');
    // The last allowed attempt does not throw: the file fails and the job is over.
    await runJob(await job(attachment.id, 3));
    processDocument.mockReset();
    expect((await fileOf(attachment.id)).ocrStatus).toBe('FAILED');
    expect(
      await prisma.practiceAttachment.count({
        where: { id: attachment.id, ...reviewQueueWhere() },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          tenantId,
          eventType: 'ATTACHMENT_READ_FAILED',
          payload: { path: ['attachmentId'], equals: attachment.id },
        },
      }),
    ).toBe(1);
    const [notice] = await notices(attachment.id);
    expect(notice.payload).toMatchObject({ outcome: 'FAILED' });
    sent.length = 0;
    const deliveries = await new AttachmentReadHandler(prisma, { telegram }).resolveDeliveries({
      ...(await job(attachment.id, 1)),
      id: notice.id,
      eventType: ATTACHMENT_READ,
      payload: notice.payload,
    });
    for (const d of deliveries) await d.send();
    expect(sent[0].text).toContain('verrà controllato manualmente');
    expect(sent[0].text).toContain('non devi rimandarlo');
  });

  it('tells nobody in chat about a file sent from the dashboard', async () => {
    processDocument.mockRejectedValueOnce(new Error('OCR worker crashed'));
    const { attachment } = await upload('dashboard');
    processDocument.mockResolvedValueOnce(READ);
    await runJob(await job(attachment.id, 1));
    expect((await fileOf(attachment.id)).ocrStatus).toBe('COMPLETED');
    expect(await notices(attachment.id)).toHaveLength(0);
  });

  it('fails at once, as before, when background reads are off', async () => {
    processDocument.mockRejectedValueOnce(new Error('OCR worker crashed'));
    const { attachment } = await upload(
      'dashboard',
      new PracticeApplicationService(prisma, { ocrService, retryFailedOcr: false }),
    );
    expect(attachment.ocrStatus).toBe('FAILED');
    expect(
      await prisma.outboxMessage.count({
        where: {
          tenantId,
          eventType: ATTACHMENT_OCR,
          payload: { path: ['attachmentId'], equals: attachment.id },
        },
      }),
    ).toBe(0);
  });
});
