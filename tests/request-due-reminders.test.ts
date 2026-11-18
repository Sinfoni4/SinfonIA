/**
 * Reminders of the documents asked for with a date (AGX-06 follow-up): two days before and on the
 * day, each once per request, to whoever the practice belongs to; never for a request answered or
 * cancelled, nor for a closed practice.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDocumentRequest } from '../src/core/practice/document-request.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import {
  DOCUMENT_REQUEST_DUE,
  DocumentRequestDueHandler,
  dueReminderText,
  italianToday,
} from '../src/core/practice/request-reminders.js';
import { DocumentRequestDueTask } from '../src/core/practice/request-reminders.js';
import { SchedulerService } from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('the reminder text', () => {
  const base = { practiceName: 'Domanda PAC', label: 'Certificato biologico', message: 'Serve' };

  it('says how many days are left, or that the date is today or past', () => {
    const today = day('2026-11-18');
    expect(dueReminderText({ ...base, dueDate: day('2026-11-20'), today })).toContain(
      'Certificato biologico, entro il 20/11/2026 (tra 2 giorni).',
    );
    expect(dueReminderText({ ...base, dueDate: day('2026-11-19'), today })).toContain(
      'entro domani, 19/11/2026.',
    );
    expect(dueReminderText({ ...base, dueDate: today, today })).toContain('entro oggi.');
    expect(
      dueReminderText({ ...base, label: undefined, dueDate: day('2026-11-15'), today }),
    ).toContain('serve ancora un documento, entro il 15/11/2026: la data è passata.');
  });

  it('counts the day in Italy', () => {
    // 23:30 UTC of the 17th is already the 18th in Rome.
    expect(italianToday(new Date('2026-11-17T23:30:00Z'))).toEqual(day('2026-11-18'));
  });
});

describe.runIf(Boolean(DATABASE_URL))('reminders of the requested documents', () => {
  const run = randomUUID().slice(0, 8);
  const chat = `97${run.replace(/\D/g, '1').slice(0, 6)}7`;
  let prisma: PrismaClient;
  let scheduler: SchedulerService;
  let handler: DocumentRequestDueHandler;
  let orgId = '';
  const people: Record<string, string> = {};
  const practice: Record<string, string> = {};
  const requests: Record<string, string> = {};
  const sent: Array<{ chatId: string; text: string }> = [];
  const telegram: ChatNotifier = {
    sendDocument: () => Promise.resolve(),
    sendMessage: (chatId, text) => {
      sent.push({ chatId, text });
      return Promise.resolve();
    },
  };

  const ask = (practiceId: string, dueDate: string | null, message: string) =>
    createDocumentRequest(prisma, {
      tenantId: orgId,
      practiceId,
      message,
      dueDate,
      actorUserId: people.admin,
      requesterOrgId: orgId,
      channel: 'dashboard',
    }).then((r) => r.id);

  /** Runs the daily check at noon in Italy of that day; returns the reminders queued. */
  const check = async (iso: string) => {
    const before = new Date();
    await scheduler.tick(new Date(`${iso}T11:00:00Z`), orgId);
    return prisma.outboxMessage.findMany({
      where: { tenantId: orgId, eventType: DOCUMENT_REQUEST_DUE, createdAt: { gte: before } },
      orderBy: { createdAt: 'asc' },
    });
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Azienda ${run}`, module: 'agri' })
    ).id;
    const users = new UserRepository(prisma);
    people.admin = (
      await users.createUser(orgId, { email: `admin-${run}@reminders.local`, role: 'ADMIN' })
    ).id;
    people.farmer = (
      await users.createUser(orgId, {
        email: `farmer-${run}@reminders.local`,
        role: 'MEMBER',
        telegramId: chat,
      })
    ).id;
    const practices = new PracticeApplicationService(prisma);
    for (const name of ['open', 'closed']) {
      practice[name] = (
        await practices.createPractice({
          tenantId: orgId,
          userId: people.farmer,
          name: `Pratica ${name} ${run}`,
        })
      ).id;
    }
    requests.near = await ask(practice.open, '2026-12-03', 'La mappa dei campi');
    requests.later = await ask(practice.open, '2026-12-20', 'Il contratto di affitto');
    requests.noDate = await ask(practice.open, null, 'Una foto del trattore');
    requests.cancelled = await ask(practice.open, '2026-12-02', 'Il vecchio certificato');
    requests.closed = await ask(practice.closed, '2026-12-02', 'Il libretto');
    await prisma.documentRequest.update({
      where: { id: requests.cancelled },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await prisma.practice.update({ where: { id: practice.closed }, data: { status: 'COMPLETED' } });
    scheduler = new SchedulerService(
      prisma,
      { exportPractices: () => Promise.reject(new Error('not here')) },
      { handlers: [new DocumentRequestDueTask(prisma)] },
    );
    handler = new DocumentRequestDueHandler(prisma, { telegram });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('reminds two days before, once, and only the open requests with a date', async () => {
    expect(await check('2026-11-30')).toEqual([]);
    const queued = await check('2026-12-01');
    expect(queued.map((m) => m.payload)).toEqual([
      { requestId: requests.near, userId: people.farmer, kind: 'before' },
    ]);
    sent.length = 0;
    for (const d of await handler.resolveDeliveries(queued[0] as unknown as ClaimedOutboxMessage)) {
      await d.send();
    }
    expect(sent.map((m) => m.chatId)).toEqual([chat]);
    expect(sent[0].text).toContain(
      `⏰ Promemoria: per la pratica «Pratica open ${run}» serve ancora un documento`,
    );
    expect(sent[0].text).toContain('«La mappa dei campi»');
    // The next day nothing new: the day's reminder comes on the date.
    expect(await check('2026-12-02')).toEqual([]);
  });

  it('reminds again on the day, then never more', async () => {
    const queued = await check('2026-12-03');
    expect(queued.map((m) => m.payload)).toEqual([
      { requestId: requests.near, userId: people.farmer, kind: 'due' },
    ]);
    expect(await check('2026-12-04')).toEqual([]);
  });

  it('sends nothing for a request answered after the reminder was queued', async () => {
    const queued = await check('2026-12-18');
    expect(queued).toHaveLength(1);
    await prisma.documentRequest.update({
      where: { id: requests.later },
      data: { status: 'FULFILLED', fulfilledAt: new Date() },
    });
    expect(await handler.resolveDeliveries(queued[0] as unknown as ClaimedOutboxMessage)).toEqual(
      [],
    );
  });
});
