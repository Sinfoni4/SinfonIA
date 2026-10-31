/**
 * A1 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.2, H9): documents waiting for a person, and the
 * confirmation or correction of the data read from them. The read result never changes, the
 * audit names the changed fields but never their values, and every caller stays in their scope.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { checkValidation } from '../src/core/practice/attachment-validation.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('checks of confirmed data', () => {
  it('accepts the fields of the type, normalised, and refuses anything else', () => {
    expect(
      checkValidation({
        documentType: 'receipt',
        fields: {
          merchantName: '  Bar  Centrale ',
          merchantVat: '01234 567890',
          totalAmount: 9.355,
        },
      }),
    ).toEqual({
      documentType: 'receipt',
      fields: {
        merchantName: 'Bar Centrale',
        merchantVat: '01234567890',
        documentDate: null,
        totalAmount: 9.36,
        vatAmount: null,
      },
    });
    expect(() => checkValidation({ documentType: 'passport', fields: {} })).toThrow(/Tipo/);
    expect(() =>
      checkValidation({ documentType: 'receipt', fields: { documentDate: '2026-02-30' } }),
    ).toThrow(/data non valida/);
    expect(() =>
      checkValidation({ documentType: 'receipt', fields: { holderName: 'Mario' } }),
    ).toThrow(/Campi non previsti/);
    expect(() => checkValidation({ documentType: 'invoice', fields: { totalAmount: -1 } })).toThrow(
      /importo/,
    );
  });
});

describe.runIf(Boolean(DATABASE_URL))('validation of document data (A1)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId: string;
  let otherOrgId: string;
  let ids: Record<string, string>;
  const people: Record<string, string> = {};

  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });
  const as = (role: 'ADMIN' | 'OPERATOR' | 'MEMBER', who = role.toLowerCase()) =>
    authHeaders(orgId, people[who], role);

  type QueueItem = {
    attachmentId: string;
    practiceName: string;
    read: { documentType: string | null; fields: Record<string, unknown> };
    validated: { data: { documentType: string }; byEmail: string | null } | null;
  };
  const queue = async (headers: Record<string, string>, status = 'to_review') =>
    (await get(`/attachments/review?status=${status}`, headers)).json<{
      data: { items: QueueItem[]; total: number };
    }>().data;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `a1-${run}` })).id;
    otherOrgId = (await tenants.createTenant({ name: `a1-altra-${run}` })).id;
    const users = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['operator', 'OPERATOR'],
      ['member', 'MEMBER'],
    ] as const) {
      people[who] = (await users.createUser(orgId, { email: `${who}-${run}@a1.local`, role })).id;
    }
    people.other = (
      await users.createUser(otherOrgId, { email: `other-${run}@a1.local`, role: 'ADMIN' })
    ).id;

    const practice = (userId: string, name: string) =>
      prisma.practice.create({
        data: { tenantId: orgId, userId, payload: { schemaVersion: 2, name } },
      });
    const memberPractice = await practice(people.member, 'Spese del membro');
    const operatorPractice = await practice(people.operator, 'Rimborso operatore');
    const attachment = (practiceId: string, fileName: string, extra: object) =>
      prisma.practiceAttachment.create({
        data: {
          tenantId: orgId,
          practiceId,
          fileName,
          mimeType: 'image/jpeg',
          fileSize: 10,
          storagePath: `a1/${run}/${fileName}`,
          ...extra,
        },
      });
    const receipt = await attachment(memberPractice.id, 'scontrino.jpg', {
      ocrStatus: 'COMPLETED',
      ocrResult: {
        documentType: 'receipt',
        merchantName: 'Bar Centrale',
        merchantVat: null,
        documentDate: '2026-10-30',
        totalAmount: 9.35,
        reviewRequired: true,
        missingFields: ['merchantVat'],
        warnings: [],
      },
    });
    const generic = await attachment(operatorPractice.id, 'foto.jpg', {
      ocrStatus: 'COMPLETED',
      ocrResult: {
        documentType: 'generic',
        title: 'DOCUMENTO COMMERCIALE',
        extractedText: 'testo',
        reviewRequired: true,
        missingFields: [],
        warnings: [],
      },
    });
    const unreadable = await attachment(operatorPractice.id, 'sfocata.jpg', {
      ocrStatus: 'FAILED',
    });
    await attachment(operatorPractice.id, 'chiara.pdf', {
      ocrStatus: 'COMPLETED',
      ocrResult: { documentType: 'generic', title: 'Ok', extractedText: '', reviewRequired: false },
    });
    ids = {
      memberPractice: memberPractice.id,
      operatorPractice: operatorPractice.id,
      receipt: receipt.id,
      generic: generic.id,
      unreadable: unreadable.id,
    };

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3010',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-a1',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      practiceService: practices,
      interpreterService: new InterpreterService(llm),
      executorService: new ExecutorService({ practiceService: practices }),
      contextService: new ContextService(practices),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const validation = (practiceId: string, attachmentId: string) =>
    `/practices/${practiceId}/attachments/${attachmentId}/validation`;

  it('lists what needs a person, each caller in their own scope', async () => {
    const staff = await queue(as('OPERATOR'));
    expect(staff.items.map((i) => i.attachmentId).sort()).toEqual(
      [ids.receipt, ids.generic, ids.unreadable].sort(),
    );
    const receipt = staff.items.find((i) => i.attachmentId === ids.receipt)!;
    expect(receipt).toMatchObject({
      practiceName: 'Spese del membro',
      read: {
        documentType: 'receipt',
        fields: { merchantName: 'Bar Centrale', totalAmount: 9.35 },
      },
      validated: null,
    });
    const own = await queue(as('MEMBER'));
    expect(own.items.map((i) => i.attachmentId)).toEqual([ids.receipt]);
    expect(
      (await queue(authHeaders(otherOrgId, people.other, 'ADMIN'))).items.map(
        (i) => i.attachmentId,
      ),
    ).toEqual([]);
  });

  it('confirms the data as read, out of the queue and off the home numbers', async () => {
    const before = await get('/dashboard/summary', as('MEMBER'));
    expect(
      before.json<{ data: { documents: { toReview: number } } }>().data.documents.toReview,
    ).toBe(1);
    const res = await post(
      validation(ids.memberPractice, ids.receipt),
      {
        documentType: 'receipt',
        fields: { merchantName: 'Bar Centrale', documentDate: '2026-10-30', totalAmount: 9.35 },
      },
      as('MEMBER'),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { outcome: string } }>().data.outcome).toBe('confirmed');
    expect((await queue(as('MEMBER'))).items).toEqual([]);
    const after = await get('/dashboard/summary', as('MEMBER'));
    expect(
      after.json<{ data: { documents: { toReview: number } } }>().data.documents.toReview,
    ).toBe(0);
    const validated = await queue(as('ADMIN'), 'validated');
    expect(validated.items[0]).toMatchObject({
      attachmentId: ids.receipt,
      validated: { byEmail: `member-${run}@a1.local` },
    });
  });

  it('corrects a wrong type, keeping what was read, and audits only the field names', async () => {
    const res = await post(
      validation(ids.operatorPractice, ids.generic),
      {
        documentType: 'receipt',
        fields: {
          merchantName: 'Pasticceria Rossi',
          totalAmount: 9.35,
          documentDate: '2026-10-30',
        },
      },
      as('ADMIN'),
    );
    expect(res.json<{ data: { outcome: string } }>().data.outcome).toBe('corrected');
    const row = await prisma.practiceAttachment.findUniqueOrThrow({ where: { id: ids.generic } });
    expect((row.ocrResult as { documentType: string }).documentType).toBe('generic');
    expect(row.validatedData).toMatchObject({
      documentType: 'receipt',
      fields: { merchantName: 'Pasticceria Rossi' },
    });
    const list = await get(`/practices/${ids.operatorPractice}/attachments`, as('ADMIN'));
    const attached = list
      .json<{ data: Array<{ id: string; validatedData: unknown }> }>()
      .data.find((a) => a.id === ids.generic);
    expect(attached?.validatedData).toMatchObject({ documentType: 'receipt' });
    const event = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'ATTACHMENT_VALIDATED', userId: people.admin },
    });
    const payload = event.payload as { outcome: string; correctedFields: string[] };
    expect(payload.outcome).toBe('corrected');
    expect(payload.correctedFields).toEqual(
      expect.arrayContaining(['documentType', 'merchantName']),
    );
    expect(JSON.stringify(event.payload)).not.toContain('Pasticceria');
  });

  it('lets a person type the data of an unreadable document', async () => {
    const res = await post(
      validation(ids.operatorPractice, ids.unreadable),
      { documentType: 'receipt', fields: { merchantName: 'Bar', totalAmount: 4 } },
      as('OPERATOR'),
    );
    expect(res.json<{ data: { outcome: string } }>().data.outcome).toBe('corrected');
  });

  it('refuses invalid data, other people’s practices and other organizations', async () => {
    const bad = await post(
      validation(ids.memberPractice, ids.receipt),
      { documentType: 'receipt', fields: { documentDate: '30/10/2026' } },
      as('ADMIN'),
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { message: string } }>().error.message).toMatch(/data non valida/);
    expect(
      (
        await post(
          validation(ids.operatorPractice, ids.generic),
          { documentType: 'generic', fields: {} },
          as('MEMBER'),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          validation(ids.memberPractice, ids.receipt),
          { documentType: 'generic', fields: {} },
          authHeaders(otherOrgId, people.other, 'ADMIN'),
        )
      ).statusCode,
    ).toBe(404);
    // The attachment must belong to the practice in the address.
    expect(
      (
        await post(
          validation(ids.memberPractice, ids.generic),
          { documentType: 'generic', fields: {} },
          as('ADMIN'),
        )
      ).statusCode,
    ).toBe(404);
  });
});
