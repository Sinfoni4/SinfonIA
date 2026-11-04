/**
 * A4 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §5): a practice is assigned to an administrator or
 * operator of the organization, who hears it in chat; the board filters by assignee.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeAssignedHandler } from '../src/core/outbox/practice-status.handler.js';
import { PRACTICE_ASSIGNED } from '../src/core/practice/practice-assignment.js';
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

describe.runIf(Boolean(DATABASE_URL))('assignment of practices (A4)', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId: string;
  let practiceId: string;
  const people: Record<string, string> = {};
  const chats = { operator: `92${digits}2` };

  const as = (who: 'admin' | 'operator' | 'member', role: UserRole) =>
    authHeaders(orgId, people[who], role);
  const assign = (userId: string | null, who: 'admin' | 'member' = 'admin') =>
    app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/assign`,
      payload: { userId },
      headers: as(who, who === 'admin' ? 'ADMIN' : 'MEMBER'),
    });
  const listIds = async (assignedTo: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/practices?assignedTo=${assignedTo}&limit=100`,
        headers: as('operator', 'OPERATOR'),
      })
    )
      .json<{ data: { items: Array<{ id: string; assignedTo: string | null }> } }>()
      .data.items.map((p) => p.id);

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (await new TenantRepository(prisma).createTenant({ name: `a4-${run}` })).id;
    const users = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['operator', 'OPERATOR'],
      ['member', 'MEMBER'],
    ] as const) {
      people[who] = (
        await users.createUser(orgId, {
          email: `${who}-${run}@a4.local`,
          role,
          ...(who === 'operator' ? { telegramId: chats.operator } : {}),
        })
      ).id;
    }
    const practices = new PracticeApplicationService(prisma);
    practiceId = (
      await practices.createPractice({ tenantId: orgId, userId: people.member, name: `Uva ${run}` })
    ).id;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3012',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-a4',
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

  it('offers only active administrators and operators', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/practices/assignees',
      headers: as('operator', 'OPERATOR'),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ data: Array<{ userId: string }> }>().data.map((a) => a.userId);
    expect(ids.sort()).toEqual([people.admin, people.operator].sort());
  });

  it('assigns to an operator, audited, and tells them in chat with the link', async () => {
    const res = await assign(people.operator);
    expect(res.statusCode).toBe(200);
    expect(await listIds('none')).not.toContain(practiceId);
    expect(await listIds(people.operator)).toContain(practiceId);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'PRACTICE_ASSIGNED' },
    });
    expect(audit.payload).toMatchObject({ practiceId, targetUserId: people.operator });

    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: { tenantId: orgId, eventType: PRACTICE_ASSIGNED },
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    const telegram: ChatNotifier = {
      sendDocument: () => Promise.resolve(),
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    };
    const deliveries = await new PracticeAssignedHandler(
      prisma,
      { telegram },
      'https://app.test/app',
    ).resolveDeliveries(message as unknown as ClaimedOutboxMessage);
    for (const d of deliveries) await d.send();
    expect(sent).toEqual([
      {
        chatId: chats.operator,
        text: `📌 Ti è stata assegnata la pratica «Uva ${run}».\nhttps://app.test/app/pratiche/${practiceId}`,
      },
    ]);
  });

  it('shows "me" to the assignee', async () => {
    expect(await listIds('me')).toContain(practiceId);
  });

  it('refuses a member as assignee, and a member as the one who assigns', async () => {
    expect((await assign(people.member)).statusCode).toBe(400);
    expect((await assign(people.admin, 'member')).statusCode).toBe(403);
  });

  it('gives the practice back to nobody', async () => {
    expect((await assign(null)).statusCode).toBe(200);
    expect(await listIds('none')).toContain(practiceId);
    const last = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'PRACTICE_ASSIGNED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(last.payload).toMatchObject({ practiceId, unassigned: true });
  });
});
