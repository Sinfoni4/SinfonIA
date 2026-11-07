/**
 * AGX-05: the computed document checklist. Each document the practice's type expects is missing,
 * to verify, valid or rejected, from the files linked to it; a rejection always has a reason and
 * is heard in chat; a later confirmation clears it.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { AttachmentRejectedHandler } from '../src/core/outbox/practice-status.handler.js';
import { listReviewQueue } from '../src/core/practice/attachment-validation.js';
import {
  ATTACHMENT_REJECTED,
  computeChecklist,
  type ChecklistAttachment,
} from '../src/core/practice/document-checklist.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60_000;

describe('checklist computation', () => {
  const expected = [
    { key: 'farm_file', label: 'Fascicolo', required: true },
    { key: 'identity', label: 'Identità', required: true },
    { key: 'chamber_record', label: 'Visura', required: false },
  ];
  const file = (over: Partial<ChecklistAttachment>): ChecklistAttachment => ({
    id: randomUUID(),
    fileName: 'f.pdf',
    expectedKey: null,
    validatedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    ...over,
  });

  it('gives each expected document the state of its best file', () => {
    const checklist = computeChecklist(expected, [
      // Rejected, then a newer one to verify: to verify wins.
      file({ expectedKey: 'farm_file', rejectedAt: new Date(), rejectionReason: 'Illeggibile' }),
      file({ expectedKey: 'farm_file', createdAt: new Date('2026-11-02T10:00:00Z') }),
      // Only a rejected one: rejected, with its reason.
      file({ expectedKey: 'identity', rejectedAt: new Date(), rejectionReason: 'Scaduto' }),
      // A file not linked to anything counts for nothing.
      file({}),
    ]);
    expect(checklist.items.map((i) => [i.key, i.state, i.rejectionReason])).toEqual([
      ['farm_file', 'to_verify', null],
      ['identity', 'rejected', 'Scaduto'],
      ['chamber_record', 'missing', null],
    ]);
    expect(checklist.counts).toEqual({ missing: 1, to_verify: 1, valid: 0, rejected: 1 });
    expect(checklist.complete).toBe(false);
  });

  it('is complete when every required document is valid, whatever the optional ones', () => {
    const valid = { validatedAt: new Date() };
    const checklist = computeChecklist(expected, [
      file({ expectedKey: 'farm_file', ...valid }),
      file({ expectedKey: 'identity', ...valid }),
    ]);
    expect(checklist.complete).toBe(true);
    expect(checklist.items[2].state).toBe('missing');
    // A rejection after the confirmation wins until a new confirmation.
    const rejected = computeChecklist(expected, [
      file({ expectedKey: 'farm_file', ...valid, rejectedAt: new Date() }),
      file({ expectedKey: 'identity', ...valid }),
    ]);
    expect(rejected.items[0].state).toBe('rejected');
    expect(rejected.complete).toBe(false);
  });
});

describe.runIf(Boolean(DATABASE_URL))('document checklist (AGX-05)', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  const farmerChat = `94${digits}4`;
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org = { company: '', network: '' };
  const people: Record<string, string> = {};
  let practiceId = '';
  const files: Record<string, string> = {};

  const as = (o: keyof typeof org, who: string, role: UserRole) =>
    authHeaders(org[o], people[who], role);
  const admin = () => as('company', 'admin', 'ADMIN');
  const farmer = () => as('company', 'farmer', 'MEMBER');
  const neighbour = () => as('company', 'neighbour', 'MEMBER');
  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const upload = (headers: Record<string, string>, extra: object = {}) =>
    call('POST', `/practices/${practiceId}/attachments`, headers, {
      fileName: 'doc.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from(`documento ${randomUUID()}`).toString('base64'),
      ...extra,
    });
  const checklist = async (headers = farmer()) =>
    (await call('GET', `/practices/${practiceId}/checklist`, headers)).json<{
      data: {
        complete: boolean;
        items: Array<{
          key: string;
          state: string;
          rejectionReason: string | null;
          attachment: { id: string } | null;
        }>;
      };
    }>().data;
  const stateOf = async (key: string) => (await checklist()).items.find((i) => i.key === key);

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.company = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    org.network = (await tenants.createTenant({ name: `Rete ${run}` })).id;
    const add = async (o: keyof typeof org, who: string, role: UserRole, extra = {}) => {
      people[who] = (
        await users.createUser(org[o], { email: `${who}-${run}@agx05.local`, role, ...extra })
      ).id;
    };
    await add('company', 'admin', 'ADMIN');
    await add('company', 'farmer', 'MEMBER', { telegramId: farmerChat });
    await add('company', 'neighbour', 'MEMBER');
    await add('network', 'netAdmin', 'ADMIN');
    await add('network', 'netOperator', 'OPERATOR');
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3016',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-agx05',
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
    practiceId = (
      await practices.createPractice({
        tenantId: org.company,
        userId: people.farmer,
        name: `Domanda PAC ${run}`,
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('starts with every expected document missing', async () => {
    const list = await checklist();
    expect(list.items.map((i) => [i.key, i.state])).toEqual([
      ['farm_file', 'missing'],
      ['identity', 'missing'],
      ['chamber_record', 'missing'],
      ['organic_certificate', 'missing'],
    ]);
    expect(list.complete).toBe(false);
    // Another member does not reach the practice, nor its checklist.
    expect((await call('GET', `/practices/${practiceId}/checklist`, neighbour())).statusCode).toBe(
      404,
    );
  });

  it('counts a file sent as an expected document as to verify', async () => {
    const res = await upload(farmer(), { expectedKey: 'farm_file' });
    expect(res.statusCode).toBe(201);
    files.farm = res.json<{ data: { attachment: { id: string } } }>().data.attachment.id;
    expect((await stateOf('farm_file'))?.state).toBe('to_verify');

    const before = await prisma.practiceAttachment.count({ where: { practiceId } });
    const wrong = await upload(farmer(), { expectedKey: 'tractor_licence' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('INVALID_EXPECTED_DOCUMENT');
    expect(await prisma.practiceAttachment.count({ where: { practiceId } })).toBe(before);
  });

  it('links a file sent earlier to an expected document, audited', async () => {
    const res = await upload(farmer());
    files.identity = res.json<{ data: { attachment: { id: string } } }>().data.attachment.id;
    expect((await stateOf('identity'))?.state).toBe('missing');
    const url = `/practices/${practiceId}/attachments/${files.identity}/expected`;
    expect((await call('POST', url, neighbour(), { expectedKey: 'identity' })).statusCode).toBe(
      404,
    );
    expect((await call('POST', url, farmer(), { expectedKey: 'identity' })).statusCode).toBe(200);
    expect((await stateOf('identity'))?.state).toBe('to_verify');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: org.company, eventType: 'ATTACHMENT_EXPECTED_SET' },
    });
    expect(audit.payload).toEqual({
      practiceId,
      attachmentId: files.identity,
      expectedKey: 'identity',
    });
  });

  it('lets only staff reject, with a reason, and tells the farmer in chat', async () => {
    const url = `/practices/${practiceId}/attachments/${files.identity}/rejection`;
    expect((await call('POST', url, farmer(), { reason: 'Non mi piace' })).statusCode).toBe(403);
    expect((await call('POST', url, admin(), { reason: '' })).statusCode).toBe(400);
    const res = await call('POST', url, admin(), { reason: 'Documento scaduto' });
    expect(res.statusCode).toBe(200);
    const item = await stateOf('identity');
    expect(item).toMatchObject({ state: 'rejected', rejectionReason: 'Documento scaduto' });

    // The reason stays with the file, never in the audit.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: org.company, eventType: 'ATTACHMENT_REJECTED' },
    });
    expect(audit.payload).toEqual({
      practiceId,
      attachmentId: files.identity,
      expectedKey: 'identity',
    });
    // A rejected file leaves the review queue: it waits for a new one.
    const queue = await listReviewQueue(prisma, {
      tenantId: org.company,
      status: 'to_review',
      page: 1,
      limit: 100,
    });
    expect(queue.items.map((i) => i.attachmentId)).not.toContain(files.identity);

    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId: org.company, eventType: ATTACHMENT_REJECTED },
    });
    expect(message.payload).toMatchObject({ userId: people.farmer });
    const sent: Array<{ chatId: string; text: string }> = [];
    const telegram: ChatNotifier = {
      sendDocument: () => Promise.resolve(),
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    };
    for (const d of await new AttachmentRejectedHandler(prisma, { telegram }).resolveDeliveries(
      message as unknown as ClaimedOutboxMessage,
    )) {
      await d.send();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(farmerChat);
    expect(sent[0].text).toContain(`della pratica «Domanda PAC ${run}» non è stato accettato`);
    expect(sent[0].text).toContain('Motivo: Documento scaduto');
  });

  it('turns documents valid when their data are confirmed, clearing a rejection', async () => {
    const confirm = (id: string, headers: Record<string, string>) =>
      call('POST', `/practices/${practiceId}/attachments/${id}/validation`, headers, {
        documentType: 'receipt',
        fields: {},
      });
    expect((await confirm(files.farm, admin())).statusCode).toBe(200);
    expect((await stateOf('farm_file'))?.state).toBe('valid');
    expect((await checklist()).complete).toBe(false);
    expect((await confirm(files.identity, farmer())).statusCode).toBe(200);
    const list = await checklist();
    expect(list.items.find((i) => i.key === 'identity')).toMatchObject({
      state: 'valid',
      rejectionReason: null,
    });
    // Both required documents valid: complete, even without the optional ones.
    expect(list.complete).toBe(true);
  });

  it('shows the checklist through a delegation and links files with UPDATE', async () => {
    const issued = await call('POST', '/grants', admin(), {
      grantee: { orgId: org.network },
      operations: ['READ', 'UPDATE'],
      validUntil: new Date(Date.now() + 60 * DAY_MS).toISOString().slice(0, 10),
    });
    const grant = issued.json<{ data: { id: string } }>().data.id;
    await call('POST', `/grants/${grant}/beneficiaries`, as('network', 'netAdmin', 'ADMIN'), {
      userId: people.netOperator,
    });
    await call('POST', `/grants/${grant}/beneficiaries/approve`, admin(), {
      userId: people.netOperator,
    });
    const operator = as('network', 'netOperator', 'OPERATOR');
    const detail = await call('GET', `/grants/${grant}/practices/${practiceId}`, operator);
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ data: { checklist: { complete: boolean } } }>().data.checklist.complete,
    ).toBe(true);

    const res = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/attachments`,
      operator,
      {
        fileName: 'visura.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from(`visura ${run}`).toString('base64'),
      },
    );
    const visura = res.json<{ data: { attachment: { id: string } } }>().data.attachment.id;
    const linked = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/attachments/${visura}/expected`,
      operator,
      { expectedKey: 'chamber_record' },
    );
    expect(linked.statusCode).toBe(200);
    expect((await stateOf('chamber_record'))?.state).toBe('to_verify');
    expect(
      await prisma.auditLog.count({
        where: {
          tenantId: org.company,
          eventType: 'DELEGATED_ACCESS',
          payload: { path: ['action'], equals: 'expected' },
        },
      }),
    ).toBe(1);
  });
});
