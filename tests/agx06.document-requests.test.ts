/**
 * AGX-06: requests for documents (integration), in both directions, along the critical path §H:
 * farmer → chat → document → TerreFVG dashboard (through a delegation) → check → request for a
 * missing document → the farmer hears it in chat and answers with the file → who asked hears it →
 * check → closure → the farmer is told → the usage of each step is recorded (AGX-07).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import {
  DocumentRequestedHandler,
  DocumentRequestFulfilledHandler,
  PRACTICE_STATUS_CHANGED,
  PracticeStatusHandler,
} from '../src/core/outbox/practice-status.handler.js';
import {
  DOCUMENT_REQUEST_FULFILLED,
  DOCUMENT_REQUESTED,
  practicesWithOpenRequests,
} from '../src/core/practice/document-request.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { resolveAttachmentTarget } from '../src/interface/telegram/telegram.attachment-target.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ChatNotifier, OutboxEventHandler } from '../src/core/outbox/outbox.delivery.js';
import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60_000;

describe('chat proposal of the practice for a file', () => {
  const p = (id: string) => ({ id, name: `Pratica ${id}`, status: 'CREATED' as const });

  it('proposes first the only open practice with a request', () => {
    const target = resolveAttachmentTarget([p('a'), p('b')], '', ['b']);
    expect(target).toMatchObject({ type: 'ask', suggested: true });
    if (target.type === 'ask') expect(target.candidates.map((c) => c.id)).toEqual(['b', 'a']);
    // Two practices with requests: the person chooses.
    expect(resolveAttachmentTarget([p('a'), p('b')], '', ['a', 'b'])).toMatchObject({
      suggested: false,
    });
    // A practice named in the caption still wins.
    const named = resolveAttachmentTarget([p('a'), p('b')], 'per la Pratica a', ['b']);
    if (named.type === 'ask') expect(named.candidates[0].id).toBe('a');
  });
});

describe.runIf(Boolean(DATABASE_URL))('document requests along the path §H (AGX-06)', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  const chats = { farmer: `95${digits}5`, operator: `96${digits}6` };
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let practices: PracticeApplicationService;
  let chat: ConversationService;
  const org = { company: '', network: '' };
  const people: Record<string, string> = {};
  let practiceId = '';
  let otherPracticeId = '';
  let grant = '';
  const sent: Array<{ chatId: string; text: string }> = [];
  const replies: string[] = [];
  const telegram: ChatNotifier = {
    sendDocument: () => Promise.resolve(),
    sendMessage: (chatId, text) => {
      sent.push({ chatId, text });
      return Promise.resolve();
    },
  };

  const as = (o: keyof typeof org, who: string, role: UserRole) =>
    authHeaders(org[o], people[who], role);
  const companyAdmin = () => as('company', 'admin', 'ADMIN');
  const farmer = () => as('company', 'farmer', 'MEMBER');
  const operator = () => as('network', 'netOperator', 'OPERATOR');
  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const delegated = (path = '') => `/grants/${grant}/practices/${practiceId}${path}`;
  const deliver = async (handler: OutboxEventHandler, eventType: string, tenantId: string) => {
    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId, eventType },
      orderBy: { createdAt: 'desc' },
    });
    sent.length = 0;
    for (const d of await handler.resolveDeliveries(message as unknown as ClaimedOutboxMessage)) {
      await d.send();
    }
    return message;
  };
  // The farmer writes to the bot: a file, then the answers.
  const say = async (text: string, file?: string) => {
    await chat.handle(
      {
        senderId: chats.farmer,
        text,
        ...(file
          ? {
              file: {
                fileName: `${file}.txt`,
                mimeType: 'text/plain',
                download: () => Promise.resolve(Buffer.from(`${file} ${run} ${randomUUID()}`)),
              },
            }
          : {}),
      },
      (t) => {
        replies.push(t);
        return Promise.resolve();
      },
    );
    return replies.at(-1) ?? '';
  };
  const checklistOf = async () =>
    (await call('GET', delegated(), operator())).json<{
      data: { checklist: { complete: boolean; items: Array<{ key: string; state: string }> } };
    }>().data.checklist;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.company = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    org.network = (await tenants.createTenant({ name: `TerreFVG ${run}` })).id;
    await prisma.tenant.update({ where: { id: org.network }, data: { type: 'NETWORK' } });
    const add = async (o: keyof typeof org, who: string, role: UserRole, extra = {}) => {
      people[who] = (
        await users.createUser(org[o], { email: `${who}-${run}@agx06.local`, role, ...extra })
      ).id;
    };
    await add('company', 'admin', 'ADMIN');
    await add('company', 'farmer', 'MEMBER', { telegramId: chats.farmer });
    await add('network', 'netAdmin', 'ADMIN');
    await add('network', 'netOperator', 'OPERATOR', { telegramId: chats.operator });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3017',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-agx06',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    practices = new PracticeApplicationService(prisma);
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

    const tenant = {
      id: org.company,
      name: `Azienda ${run}`,
      module: 'agri',
      disabledFeatures: [],
    } as unknown as Tenant;
    chat = new ConversationService(
      {
        practiceService: practices,
        handleMessage: () => Promise.resolve('…'),
        practicesWithOpenRequests: (input) => practicesWithOpenRequests(prisma, input),
      },
      {
        name: 'telegram',
        identity: {
          resolve: () =>
            Promise.resolve({
              tenant,
              userId: people.farmer,
              role: 'MEMBER',
              customPermissions: null,
            }),
        },
      },
    );

    // The company opens two practices for the farmer (AGX-03) and delegates TerreFVG (AGX-04).
    practiceId = (
      await practices.createPractice({
        tenantId: org.company,
        userId: people.admin,
        holderUserId: people.farmer,
        name: `Domanda PAC ${run}`,
      })
    ).id;
    otherPracticeId = (
      await practices.createPractice({
        tenantId: org.company,
        userId: people.admin,
        holderUserId: people.farmer,
        name: `Bando PSR ${run}`,
      })
    ).id;
    const issued = await call('POST', '/grants', companyAdmin(), {
      grantee: { orgId: org.network },
      operations: ['READ', 'UPDATE'],
      validUntil: new Date(Date.now() + 90 * DAY_MS).toISOString().slice(0, 10),
    });
    grant = issued.json<{ data: { id: string } }>().data.id;
    await call('POST', `/grants/${grant}/beneficiaries`, as('network', 'netAdmin', 'ADMIN'), {
      userId: people.netOperator,
    });
    await call('POST', `/grants/${grant}/beneficiaries/approve`, companyAdmin(), {
      userId: people.netOperator,
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('1. the farmer sends the farm file in chat, choosing the practice', async () => {
    // Two open practices and no request: the farmer is asked which one.
    expect(await say('', 'fascicolo')).toContain('A quale pratica lo associo?');
    const position = replies.at(-1)!.includes(`1) Domanda PAC ${run}`) ? '1' : '2';
    expect(await say(position)).toContain(`📁 Pratica: Domanda PAC ${run}`);
    const files = await prisma.practiceAttachment.findMany({ where: { practiceId } });
    expect(files).toHaveLength(1);
    // TerreFVG links it as the farm file through the delegation, and confirms its data.
    const linked = await call(
      'POST',
      delegated(`/attachments/${files[0].id}/expected`),
      operator(),
      {
        expectedKey: 'farm_file',
      },
    );
    expect(linked.statusCode).toBe(200);
    const checked = await call(
      'POST',
      delegated(`/attachments/${files[0].id}/validation`),
      operator(),
      {
        documentType: 'receipt',
        fields: {},
      },
    );
    expect(checked.statusCode).toBe(200);
    const list = await checklistOf();
    expect(list.items.find((i) => i.key === 'farm_file')?.state).toBe('valid');
    expect(list.complete).toBe(false);
  });

  it('2. TerreFVG asks for the identity document; the farmer hears it in chat', async () => {
    // Only who checks the documents asks: not the farmer, not without a reason.
    expect(
      (
        await call('POST', `/practices/${practiceId}/document-requests`, farmer(), {
          message: 'Mi serve?',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', delegated('/document-requests'), operator(), { message: 'x' }))
        .statusCode,
    ).toBe(400);
    const res = await call('POST', delegated('/document-requests'), operator(), {
      expectedKey: 'identity',
      message: 'Serve la carta d’identità del titolare, fronte e retro',
      dueDate: new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10),
    });
    expect(res.statusCode).toBe(201);
    const request = res.json<{ data: { id: string; status: string; expectedLabel: string } }>()
      .data;
    expect(request).toMatchObject({
      status: 'OPEN',
      expectedLabel: "Documento d'identità del titolare",
    });

    // The text of the request goes in chat, never into the audit.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: org.company, eventType: 'DOCUMENT_REQUESTED' },
    });
    expect(audit.userId).toBe(people.netOperator);
    expect(JSON.stringify(audit.payload)).not.toContain('carta');

    await deliver(
      new DocumentRequestedHandler(prisma, { telegram }),
      DOCUMENT_REQUESTED,
      org.company,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(chats.farmer);
    expect(sent[0].text).toContain(
      `Per la pratica «Domanda PAC ${run}» serve un documento: Documento d'identità del titolare.`,
    );
    expect(sent[0].text).toContain('fronte e retro');
    expect(sent[0].text).toContain('Entro il');

    // The farmer sees it among the requests of the practice.
    const seen = await call('GET', `/practices/${practiceId}/document-requests`, farmer());
    expect(seen.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual([
      request.id,
    ]);
  });

  it('3. the farmer answers with the file in chat; TerreFVG hears it arrived', async () => {
    // The practice with the request is proposed first, confirmed with «sì».
    expect(await say('', 'carta-identita')).toContain(
      `Lo associo alla pratica «Domanda PAC ${run}»?`,
    );
    const answer = await say('sì');
    expect(answer).toContain(`📁 Pratica: Domanda PAC ${run}`);
    expect(answer).toContain("📎 Ho risposto alla richiesta: Documento d'identità del titolare.");

    const request = await prisma.documentRequest.findFirstOrThrow({ where: { practiceId } });
    expect(request.status).toBe('FULFILLED');
    // The file became the identity document of the checklist.
    expect((await checklistOf()).items.find((i) => i.key === 'identity')?.state).toBe('to_verify');

    // TerreFVG hears it in its own organization, with the link to the delegated practice.
    await deliver(
      new DocumentRequestFulfilledHandler(prisma, { telegram }, 'https://app.test/app'),
      DOCUMENT_REQUEST_FULFILLED,
      org.network,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(chats.operator);
    expect(sent[0].text).toContain(
      `È arrivato il documento richiesto per la pratica «Domanda PAC ${run}»`,
    );
    expect(sent[0].text).toContain(`https://app.test/app/deleghe/${grant}/pratiche/${practiceId}`);
  });

  it('4. TerreFVG checks it and closes the practice; the farmer is told', async () => {
    const identity = await prisma.practiceAttachment.findFirstOrThrow({
      where: { practiceId, expectedKey: 'identity' },
    });
    expect(
      (
        await call('POST', delegated(`/attachments/${identity.id}/validation`), operator(), {
          documentType: 'receipt',
          fields: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await checklistOf()).complete).toBe(true);
    for (const nextState of ['SUBMITTED', 'COMPLETED']) {
      const moved = await call('POST', delegated('/transition'), operator(), { nextState });
      expect(moved.statusCode).toBe(200);
    }
    await deliver(
      new PracticeStatusHandler(prisma, { telegram }),
      PRACTICE_STATUS_CHANGED,
      org.company,
    );
    expect(sent).toEqual([
      { chatId: chats.farmer, text: `🎉 La tua pratica «Domanda PAC ${run}» è stata completata.` },
    ]);
    // A closed practice takes no new requests.
    expect(
      (await call('POST', delegated('/document-requests'), operator(), { message: 'Ancora una' }))
        .statusCode,
    ).toBe(409);
  });

  it('5. every step left its usage, the network’s ones with the network as actor (AGX-07)', async () => {
    const usage = await prisma.usageEvent.findMany({
      where: { practiceId },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, actorOrgId: true },
    });
    expect(usage).toEqual([
      // Opened by the company for the farmer.
      { kind: 'PRACTICE_OPENED', actorOrgId: null },
      // The farm file and the identity document, both sent by the farmer in chat.
      { kind: 'DOCUMENT_RECEIVED', actorOrgId: null },
      { kind: 'DOCUMENT_REQUESTED', actorOrgId: org.network },
      { kind: 'DOCUMENT_RECEIVED', actorOrgId: null },
      { kind: 'PRACTICE_COMPLETED', actorOrgId: org.network },
    ]);
  });

  it('leaves a file unmatched when several requests could fit, for staff to link', async () => {
    const ask = (message: string) =>
      call('POST', `/practices/${otherPracticeId}/document-requests`, companyAdmin(), { message });
    const first = (await ask('Preventivo della trattrice')).json<{ data: { id: string } }>().data;
    const second = (await ask('Planimetria del capannone')).json<{ data: { id: string } }>().data;
    const upload = await practices.addAttachment({
      tenantId: org.company,
      userId: people.farmer,
      practiceId: otherPracticeId,
      fileName: 'preventivo.txt',
      mimeType: 'text/plain',
      content: Buffer.from(`preventivo ${run}`),
      channel: 'telegram',
    });
    expect(upload.fulfilledRequest).toBeNull();

    // Staff link it to the right request, and cancel the other one.
    const fulfil = await call(
      'POST',
      `/practices/${otherPracticeId}/document-requests/${first.id}/fulfil`,
      companyAdmin(),
      { attachmentId: upload.attachment.id },
    );
    expect(fulfil.statusCode).toBe(200);
    const cancel = await call(
      'POST',
      `/practices/${otherPracticeId}/document-requests/${second.id}/cancel`,
      companyAdmin(),
      {},
    );
    expect(cancel.statusCode).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/practices/${otherPracticeId}/document-requests/${second.id}/cancel`,
          companyAdmin(),
          {},
        )
      ).statusCode,
    ).toBe(409);
    const rows = await prisma.documentRequest.findMany({
      where: { practiceId: otherPracticeId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['FULFILLED', 'CANCELLED']);
    // The staff queue lists only open requests.
    const queue = await call('GET', '/document-requests', companyAdmin());
    expect(queue.json<{ data: unknown[] }>().data).toEqual([]);
    expect((await call('GET', '/document-requests', farmer())).statusCode).toBe(403);
  });

  it('answers a request named on upload, and refuses one no longer open', async () => {
    const res = await call(
      'POST',
      `/practices/${otherPracticeId}/document-requests`,
      companyAdmin(),
      {
        message: 'Visura aggiornata',
        expectedKey: 'chamber_record',
      },
    );
    const requestId = res.json<{ data: { id: string } }>().data.id;
    const upload = (id: string, text: string) =>
      call('POST', `/practices/${otherPracticeId}/attachments`, farmer(), {
        fileName: 'visura.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from(`${text} ${run}`).toString('base64'),
        requestId: id,
      });
    const ok = await upload(requestId, 'visura');
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ data: { fulfilledRequest: { id: string } } }>().data.fulfilledRequest.id).toBe(
      requestId,
    );
    const again = await upload(requestId, 'visura bis');
    expect(again.statusCode).toBe(409);
  });

  it('tells TerreFVG nothing once the delegation is revoked', async () => {
    await call('POST', `/grants/${grant}/revoke`, companyAdmin(), {});
    await deliver(
      new DocumentRequestFulfilledHandler(prisma, { telegram }),
      DOCUMENT_REQUEST_FULFILLED,
      org.network,
    );
    expect(sent).toEqual([]);
  });
});
