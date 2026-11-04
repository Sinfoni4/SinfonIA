/**
 * A3 and H10 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §5): the owner of a practice hears in chat
 * when someone else changes its state; «parla con un operatore» records a request that the staff
 * see in the dashboard, with chat notices to the operators and back to the person.
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
  ASSISTANCE_REQUESTED,
  ASSISTANCE_UPDATED,
  requestAssistance,
} from '../src/core/assistance/assistance.service.js';
import {
  AssistanceRequestedHandler,
  AssistanceUpdatedHandler,
} from '../src/core/outbox/assistance.handler.js';
import {
  formatPracticeStatusNotice,
  PRACTICE_STATUS_CHANGED,
  PracticeStatusHandler,
} from '../src/core/outbox/practice-status.handler.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ChatNotifier, OutboxEventHandler } from '../src/core/outbox/outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('chat notice of a practice state (A3)', () => {
  it('speaks of the practice by name, and points to the operator when it failed', () => {
    expect(formatPracticeStatusNotice('Vendemmia 2026', 'VALIDATED')).toBe(
      '✅ La tua pratica «Vendemmia 2026» è stata validata.',
    );
    expect(formatPracticeStatusNotice('Vendemmia 2026', 'FAILED')).toContain('«operatore»');
    expect(formatPracticeStatusNotice('Vendemmia 2026', 'CREATED')).toBeNull();
  });
});

describe.runIf(Boolean(DATABASE_URL))('notices and assistance requests with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId: string;
  const people: Record<string, string> = {};
  const chats = {
    admin: `91${run.replace(/\D/g, '1').slice(0, 6)}1`,
    operator: `91${run.replace(/\D/g, '1').slice(0, 6)}2`,
    member: `91${run.replace(/\D/g, '1').slice(0, 6)}3`,
  };
  const sent: Array<{ chatId: string; text: string }> = [];
  const telegram: ChatNotifier = {
    sendDocument: () => Promise.resolve(),
    sendMessage: (chatId, text) => {
      sent.push({ chatId, text });
      return Promise.resolve();
    },
  };

  const as = (who: 'admin' | 'operator' | 'member', role: UserRole) =>
    authHeaders(orgId, people[who], role);

  /** Delivers the latest outbox message of a type through its handler; returns who got what. */
  const deliverLatest = async (eventType: string, handler: OutboxEventHandler) => {
    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId: orgId, eventType },
      orderBy: { createdAt: 'desc' },
    });
    sent.length = 0;
    const deliveries = await handler.resolveDeliveries(message as unknown as ClaimedOutboxMessage);
    for (const d of deliveries) await d.send();
    return [...sent];
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (await new TenantRepository(prisma).createTenant({ name: `a3-${run}` })).id;
    const users = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['operator', 'OPERATOR'],
      ['member', 'MEMBER'],
    ] as const) {
      people[who] = (
        await users.createUser(orgId, {
          email: `${who}-${run}@a3.local`,
          role,
          telegramId: chats[who],
        })
      ).id;
    }
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3011',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-a3',
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

  describe('A3', () => {
    const practices = () => new PracticeApplicationService(prisma);
    const notices = () =>
      prisma.outboxMessage.count({
        where: { tenantId: orgId, eventType: PRACTICE_STATUS_CHANGED },
      });

    it('tells only the owner when an operator moves their practice', async () => {
      const practice = await practices().createPractice({
        tenantId: orgId,
        userId: people.member,
        name: `Vendemmia ${run}`,
      });
      const before = await notices();
      await practices().transitionPractice({
        tenantId: orgId,
        userId: people.operator,
        practiceId: practice.id,
        nextState: 'VALIDATED',
      });
      expect(await notices()).toBe(before + 1);
      const got = await deliverLatest(
        PRACTICE_STATUS_CHANGED,
        new PracticeStatusHandler(prisma, { telegram }),
      );
      expect(got).toEqual([
        { chatId: chats.member, text: `✅ La tua pratica «Vendemmia ${run}» è stata validata.` },
      ]);
    });

    it('sends nothing when the owner moves the practice themselves', async () => {
      const practice = await practices().createPractice({
        tenantId: orgId,
        userId: people.operator,
        name: `Propria ${run}`,
      });
      const before = await notices();
      await practices().transitionPractice({
        tenantId: orgId,
        userId: people.operator,
        practiceId: practice.id,
        nextState: 'VALIDATED',
      });
      expect(await notices()).toBe(before);
    });
  });

  describe('«parla con un operatore» (H10)', () => {
    type Item = {
      id: string;
      topic: string;
      status: string;
      requester: { email: string | null; channels: string[]; practices: number };
      takenByEmail: string | null;
    };
    const list = async (status = 'open') => {
      const res = await app.inject({
        method: 'GET',
        url: `/assistance?status=${status}`,
        headers: as('operator', 'OPERATOR'),
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ data: { items: Item[]; total: number } }>().data;
    };
    const act = (id: string, action: 'take' | 'close', who: 'admin' | 'operator' = 'operator') =>
      app.inject({
        method: 'POST',
        url: `/assistance/${id}/${action}`,
        payload: {},
        headers: as(who, who === 'admin' ? 'ADMIN' : 'OPERATOR'),
      });

    it('records one request per person, audited, and tells the staff without names', async () => {
      const first = await requestAssistance(prisma, {
        tenantId: orgId,
        userId: people.member,
        topic: 'DOCUMENT',
        channel: 'TELEGRAM',
      });
      expect(first.created).toBe(true);
      const again = await requestAssistance(prisma, {
        tenantId: orgId,
        userId: people.member,
        topic: 'OTHER',
        channel: 'TELEGRAM',
      });
      expect(again).toEqual({ created: false, createdAt: first.createdAt });
      expect(
        await prisma.assistanceRequest.count({ where: { tenantId: orgId, userId: people.member } }),
      ).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId: orgId, eventType: 'ASSISTANCE_REQUESTED' },
      });
      expect(audit.payload).toMatchObject({ topic: 'DOCUMENT', channel: 'telegram' });

      const got = await deliverLatest(
        ASSISTANCE_REQUESTED,
        new AssistanceRequestedHandler(prisma, { telegram }, 'https://app.test/app/assistenza'),
      );
      expect(got.map((g) => g.chatId).sort()).toEqual([chats.admin, chats.operator].sort());
      expect(got[0].text).toBe(
        '🙋 Nuova richiesta di assistenza su un documento.\n' +
          'Gestiscila dalla dashboard: https://app.test/app/assistenza',
      );
      expect(got[0].text).not.toContain(`member-${run}`);
    });

    it('is listed for the staff and refused to a member', async () => {
      const open = await list();
      expect(open.items).toHaveLength(1);
      expect(open.items[0]).toMatchObject({
        topic: 'DOCUMENT',
        status: 'OPEN',
        requester: { email: `member-${run}@a3.local`, channels: ['TELEGRAM'] },
      });
      const member = await app.inject({
        method: 'GET',
        url: '/assistance',
        headers: as('member', 'MEMBER'),
      });
      expect(member.statusCode).toBe(403);
      // Another organization: covered for every route with an id in tests/authz.coverage.test.ts.
    });

    it('is taken in charge once, then closed, and the person hears both in chat', async () => {
      const [item] = (await list()).items;
      expect((await act(item.id, 'take')).statusCode).toBe(200);
      const twice = await act(item.id, 'take', 'admin');
      expect(twice.statusCode).toBe(409);
      expect((await list()).items[0]).toMatchObject({
        status: 'IN_PROGRESS',
        takenByEmail: `operator-${run}@a3.local`,
      });
      const taken = await deliverLatest(
        ASSISTANCE_UPDATED,
        new AssistanceUpdatedHandler(prisma, { telegram }),
      );
      expect(taken.map((t) => t.chatId)).toEqual([chats.member]);
      expect(taken[0].text).toContain('preso in carico');

      expect((await act(item.id, 'close', 'admin')).statusCode).toBe(200);
      expect((await act(item.id, 'close')).statusCode).toBe(409);
      expect((await list()).total).toBe(0);
      expect((await list('closed')).items.map((i) => i.id)).toEqual([item.id]);
      const closed = await deliverLatest(
        ASSISTANCE_UPDATED,
        new AssistanceUpdatedHandler(prisma, { telegram }),
      );
      expect(closed.map((t) => t.chatId)).toEqual([chats.member]);
      expect(closed[0].text).toContain('chiusa');
      expect(
        await prisma.auditLog.count({
          where: { tenantId: orgId, eventType: { in: ['ASSISTANCE_TAKEN', 'ASSISTANCE_CLOSED'] } },
        }),
      ).toBe(2);

      // Once closed, a new request can be made.
      const next = await requestAssistance(prisma, {
        tenantId: orgId,
        userId: people.member,
        topic: 'PRACTICE',
        channel: 'TELEGRAM',
      });
      expect(next.created).toBe(true);
    });

    it('does not tell the staff about a request already handled', async () => {
      const [item] = (await list()).items;
      await act(item.id, 'close');
      const message = await prisma.outboxMessage.findFirstOrThrow({
        where: { tenantId: orgId, eventType: ASSISTANCE_REQUESTED },
        orderBy: { createdAt: 'desc' },
      });
      const deliveries = await new AssistanceRequestedHandler(prisma, {
        telegram,
      }).resolveDeliveries(message as unknown as ClaimedOutboxMessage);
      expect(deliveries).toEqual([]);
    });
  });
});
