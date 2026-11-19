/**
 * AGX-03: the holder of a practice. An operator opens a practice for a farmer of the organization:
 * the farmer sees it, attaches documents and hears its notices; other members do not. Only who may
 * assign practices chooses the holder; deleting stays with the creator.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { dashboardSummary } from '../src/core/dashboard/dashboard.service.js';
import {
  PRACTICE_STATUS_CHANGED,
  PracticeHolderSetHandler,
  PracticeStatusHandler,
} from '../src/core/outbox/practice-status.handler.js';
import { PRACTICE_HOLDER_SET } from '../src/core/practice/practice-holder.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { formatPracticeCommandResult } from '../src/interface/telegram/practice.command.formatter.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

type Who = 'admin' | 'operator' | 'farmer' | 'neighbour' | 'outsider';
const ROLES: Record<Who, UserRole> = {
  admin: 'ADMIN',
  operator: 'OPERATOR',
  farmer: 'MEMBER',
  neighbour: 'MEMBER',
  outsider: 'MEMBER',
};

describe.runIf(Boolean(DATABASE_URL))('practice holder (AGX-03)', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  const farmerChat = `93${digits}3`;
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let practices: PracticeApplicationService;
  let orgId: string;
  let otherOrgId: string;
  let practiceId: string;
  const people = {} as Record<Who, string>;

  const as = (who: Who) =>
    authHeaders(who === 'outsider' ? otherOrgId : orgId, people[who], ROLES[who]);
  const listIds = async (who: Who, query = '') =>
    (await app.inject({ method: 'GET', url: `/practices?limit=100${query}`, headers: as(who) }))
      .json<{ data: { items: Array<{ id: string }> } }>()
      .data.items.map((p) => p.id);
  const create = (who: Who, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/practices', payload: body, headers: as(who) });
  const setHolder = (who: Who, userId: string | null) =>
    app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/holder`,
      payload: { userId },
      headers: as(who),
    });
  const upload = (who: Who) =>
    app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/attachments`,
      payload: {
        fileName: 'visura.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from(`visura ${who} ${randomUUID()}`).toString('base64'),
      },
      headers: as(who),
    });
  const telegramSink = () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const telegram: ChatNotifier = {
      sendDocument: () => Promise.resolve(),
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    };
    return { sent, telegram };
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `agx03-${run}`, module: 'agri' })).id;
    otherOrgId = (await tenants.createTenant({ name: `agx03-other-${run}` })).id;
    const users = new UserRepository(prisma);
    for (const who of Object.keys(ROLES) as Who[]) {
      people[who] = (
        await users.createUser(who === 'outsider' ? otherOrgId : orgId, {
          email: `${who}-${run}@agx03.local`,
          role: ROLES[who],
          ...(who === 'farmer' ? { telegramId: farmerChat } : {}),
        })
      ).id;
    }
    practices = new PracticeApplicationService(prisma);
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3013',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-agx03',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
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

  it('lets an operator open a practice for a farmer, audited, and tells the farmer', async () => {
    const res = await create('operator', {
      name: `Domanda PAC ${run}`,
      holderUserId: people.farmer,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; userId: string; holderUserId: string } }>().data;
    practiceId = body.id;
    expect(body).toMatchObject({ userId: people.operator, holderUserId: people.farmer });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'PRACTICE_CREATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.payload).toEqual({ practiceId, targetUserId: people.farmer });

    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId: orgId, eventType: PRACTICE_HOLDER_SET },
    });
    const { sent, telegram } = telegramSink();
    const deliveries = await new PracticeHolderSetHandler(
      prisma,
      { telegram },
      'https://app.test/app',
    ).resolveDeliveries(message as unknown as ClaimedOutboxMessage);
    for (const d of deliveries) await d.send();
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(farmerChat);
    expect(sent[0].text).toContain(`È stata aperta per te la pratica «Domanda PAC ${run}»`);
    expect(sent[0].text).toContain(`https://app.test/app/pratiche/${practiceId}`);
  });

  it('shows the practice to the farmer, never to another member', async () => {
    expect(await listIds('farmer')).toContain(practiceId);
    expect(await listIds('neighbour')).not.toContain(practiceId);
    const own = await app.inject({
      method: 'GET',
      url: `/practices/${practiceId}`,
      headers: as('farmer'),
    });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({
      method: 'GET',
      url: `/practices/${practiceId}`,
      headers: as('neighbour'),
    });
    expect(other.statusCode).toBe(404);
    // The administrator filtering by person finds it under the farmer as well.
    expect(await listIds('admin', `&userId=${people.farmer}`)).toContain(practiceId);
    // The farmer's home counts it.
    const home = await dashboardSummary(prisma, undefined, {
      tenantId: orgId,
      practiceUserId: people.farmer,
    });
    expect(JSON.stringify(home)).toContain(practiceId);
  });

  it('lets the farmer attach documents and read them, not another member', async () => {
    expect((await upload('farmer')).statusCode).toBe(201);
    expect((await upload('neighbour')).statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: `/practices/${practiceId}/attachments`,
      headers: as('farmer'),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('sends the state notices to the farmer, not to the operator who opened it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/transition`,
      payload: { nextState: 'VALIDATED' },
      headers: as('operator'),
    });
    expect(res.statusCode).toBe(200);
    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId: orgId, eventType: PRACTICE_STATUS_CHANGED },
      orderBy: { createdAt: 'desc' },
    });
    expect(message.payload).toMatchObject({ practiceId, userId: people.farmer });
    const { sent, telegram } = telegramSink();
    const deliveries = await new PracticeStatusHandler(prisma, { telegram }).resolveDeliveries(
      message as unknown as ClaimedOutboxMessage,
    );
    for (const d of deliveries) await d.send();
    expect(sent).toEqual([
      { chatId: farmerChat, text: `✅ La tua pratica «Domanda PAC ${run}» è stata validata.` },
    ]);
  });

  it('does not let the farmer delete it from the chat', async () => {
    const farmer = {
      tenantId: orgId,
      userId: people.farmer,
      role: 'MEMBER' as const,
      customPermissions: null,
    };
    const result = await practices.executeCommand(
      { type: 'DELETE_PRACTICE', payload: { name: `Domanda PAC ${run}` } },
      farmer,
    );
    expect(result.type).toBe('delete_denied');
    expect(formatPracticeCommandResult(result)).toContain('può eliminarla solo chi');
    await expect(
      practices.executeCommand({ type: 'CONFIRM_DELETE', payload: { practiceId } }, farmer),
    ).rejects.toThrow();
    expect(await prisma.practice.count({ where: { id: practiceId } })).toBe(1);
  });

  it('keeps the choice of the holder to who may assign practices', async () => {
    const byMember = await create('farmer', {
      name: `Per il vicino ${run}`,
      holderUserId: people.neighbour,
    });
    expect(byMember.statusCode).toBe(403);
    expect((await setHolder('farmer', people.neighbour)).statusCode).toBe(403);
    // A member may still name themselves: that is just their own practice.
    const self = await create('farmer', { name: `Mia ${run}`, holderUserId: people.farmer });
    expect(self.statusCode).toBe(201);
    expect(self.json<{ data: { holderUserId: string | null } }>().data.holderUserId).toBeNull();
  });

  it('refuses a holder outside the organization, and saves nothing', async () => {
    const before = await prisma.practice.count({ where: { tenantId: orgId } });
    const res = await create('operator', { name: `Fuori ${run}`, holderUserId: people.outsider });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_HOLDER');
    expect(await prisma.practice.count({ where: { tenantId: orgId } })).toBe(before);
    expect((await setHolder('admin', people.outsider)).statusCode).toBe(400);
  });

  it('moves the practice to another holder, then back to its creator', async () => {
    expect((await setHolder('admin', people.neighbour)).statusCode).toBe(200);
    expect(await listIds('neighbour')).toContain(practiceId);
    expect(await listIds('farmer')).not.toContain(practiceId);
    // The old holder no longer hears the notices of the practice.
    const stale = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId: orgId, eventType: PRACTICE_STATUS_CHANGED },
      orderBy: { createdAt: 'desc' },
    });
    const { telegram } = telegramSink();
    expect(
      await new PracticeStatusHandler(prisma, { telegram }).resolveDeliveries(
        stale as unknown as ClaimedOutboxMessage,
      ),
    ).toEqual([]);

    expect((await setHolder('admin', null)).statusCode).toBe(200);
    expect(await listIds('neighbour')).not.toContain(practiceId);
    const changes = await prisma.auditLog.findMany({
      where: { tenantId: orgId, eventType: 'PRACTICE_HOLDER_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(changes.map((c) => c.payload)).toEqual([
      { practiceId, targetUserId: people.neighbour },
      { practiceId },
    ]);
    // Setting the same holder again records nothing.
    expect((await setHolder('admin', null)).statusCode).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: orgId, eventType: 'PRACTICE_HOLDER_CHANGED' },
      }),
    ).toBe(2);
  });

  it('offers the active members of the organization as holders', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/practices/holders',
      headers: as('operator'),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ data: Array<{ userId: string }> }>().data.map((c) => c.userId);
    expect(ids.sort()).toEqual(
      [people.admin, people.operator, people.farmer, people.neighbour].sort(),
    );
    expect(
      (await app.inject({ method: 'GET', url: '/practices/holders', headers: as('farmer') }))
        .statusCode,
    ).toBe(403);
  });
});
