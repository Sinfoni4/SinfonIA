/**
 * Export rules D5 and D5b option b (approved 29/10/2026): an OPERATOR exports its own practices
 * unless an ADMIN grants the organization; every manual export is audited; in chat the export is
 * always of one's own practices; the scheduled export reaches in chat only the ADMINs who chose it,
 * and every delivery is audited. docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §3.3.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { setScheduledExport } from '../src/core/identity/member-access.service.js';
import { revokeMembership } from '../src/core/identity/revocation.service.js';
import {
  PRACTICE_EXPORT_GENERATED,
  PracticeExportHandler,
} from '../src/core/outbox/practice-export.handler.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { getTenantById } from '../src/core/tenant/tenant.store.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { OutboxRepository } from '../src/data/repositories/outbox.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('export rules D5 and D5b', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let tenantId: string;
  const users = { admin: '', admin2: '', operator: '', member: '' };
  const telegram = { admin: `9${run}1`, admin2: `9${run}2`, member: `9${run}3` };

  const exportAs = async (who: keyof typeof users, role: UserRole) =>
    (
      await app.inject({
        method: 'POST',
        url: '/practices/export',
        headers: authHeaders(tenantId, users[who], role),
        payload: {},
      })
    ).json<{ data: { count: number } }>().data.count;

  const chat = (who: keyof typeof users, role: UserRole) => {
    const replies: string[] = [];
    const service = new ConversationService(
      {
        practiceService: new PracticeApplicationService(prisma),
        handleMessage: () => Promise.resolve('ai'),
        scheduledExport: (orgId, userId, enabled) =>
          setScheduledExport(prisma, orgId, userId, enabled, { userId }),
      },
      {
        name: 'telegram',
        identity: {
          link: () => Promise.resolve(null),
          resolve: async () => ({
            tenant: await getTenantById(prisma, tenantId),
            userId: users[who],
            role,
          }),
        },
      },
    );
    return async (text: string) => {
      await service.handle({ senderId: who, text }, (t) => {
        replies.push(t);
        return Promise.resolve();
      });
      return replies.at(-1) ?? '';
    };
  };

  const auditCount = (eventType: string, extra: Record<string, unknown> = {}) =>
    prisma.auditLog.count({ where: { tenantId, eventType, ...extra } });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (await new TenantRepository(prisma).createTenant({ name: `mf8a-${run}` })).id;
    const repo = new UserRepository(prisma);
    const create = async (name: string, role: UserRole, telegramId?: string) =>
      (
        await repo.createUser(tenantId, {
          email: `${name}-${run}@mf8a.local`,
          role,
          ...(telegramId ? { telegramId } : {}),
        })
      ).id;
    users.admin = await create('admin', 'ADMIN', telegram.admin);
    users.admin2 = await create('admin2', 'ADMIN', telegram.admin2);
    users.operator = await create('operator', 'OPERATOR');
    users.member = await create('member', 'MEMBER', telegram.member);
    const practices = new PracticeApplicationService(prisma);
    for (const who of ['admin', 'operator', 'member'] as const) {
      await practices.createPractice({
        tenantId,
        userId: users[who],
        name: `Pratica ${who} ${run}`,
        kind: 'music',
      });
    }

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3006',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-mf8a',
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

  it('lets an OPERATOR export the organization only while an ADMIN grants it', async () => {
    expect(await exportAs('admin', 'ADMIN')).toBe(3);
    expect(await exportAs('operator', 'OPERATOR')).toBe(1);

    const grant = (userId: string, granted: boolean) =>
      app.inject({
        method: 'POST',
        url: `/members/${userId}/permissions`,
        headers: authHeaders(tenantId, users.admin, 'ADMIN'),
        payload: { permission: 'practice.export', granted },
      });
    expect((await grant(users.operator, true)).statusCode).toBe(200);
    expect(await exportAs('operator', 'OPERATOR')).toBe(3);
    expect((await grant(users.operator, false)).statusCode).toBe(200);
    expect(await exportAs('operator', 'OPERATOR')).toBe(1);

    // Never for a MEMBER, and never by someone who is not an ADMIN.
    expect((await grant(users.member, true)).statusCode).toBe(409);
    const byOperator = await app.inject({
      method: 'POST',
      url: `/members/${users.operator}/permissions`,
      headers: authHeaders(tenantId, users.operator, 'OPERATOR'),
      payload: { permission: 'practice.export', granted: true },
    });
    expect(byOperator.statusCode).toBe(403);
    expect(await auditCount('PERMISSION_GRANTED')).toBe(1);
    expect(await auditCount('PERMISSION_WITHDRAWN')).toBe(1);
  });

  it('audits every manual export without its content', async () => {
    const before = await auditCount('EXPORT_GENERATED');
    await exportAs('member', 'MEMBER');
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, eventType: 'EXPORT_GENERATED', userId: users.member },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry.payload).toEqual({
      channel: 'api',
      scope: 'own',
      filter: { type: 'all' },
      rows: 1,
    });
    expect(await auditCount('EXPORT_GENERATED')).toBe(before + 1);
  });

  it('exports only own practices in chat, even for an ADMIN, and audits the channel', async () => {
    const reply = await chat('admin', 'ADMIN')('export pratiche');
    expect(reply).toContain(`Pratica admin ${run}`);
    expect(reply).not.toContain(`Pratica member ${run}`);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, eventType: 'EXPORT_GENERATED', userId: users.admin },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry.payload).toMatchObject({ channel: 'telegram', scope: 'own', rows: 1 });
  });

  describe('scheduled export in chat', () => {
    const sent: string[] = [];
    const notifier: ChatNotifier = {
      sendDocument: (chatId: string) => {
        sent.push(chatId);
        return Promise.resolve();
      },
      sendMessage: (chatId: string) => {
        sent.push(chatId);
        return Promise.resolve();
      },
    };
    const deliver = async () => {
      sent.length = 0;
      const message = (await new OutboxRepository(prisma).createMessage({
        tenantId,
        eventType: PRACTICE_EXPORT_GENERATED,
        payload: { title: 'Export', csv: 'Nome\nX\n', practiceCount: 3 },
      })) as unknown as ClaimedOutboxMessage;
      const deliveries = await new PracticeExportHandler(prisma, {
        telegram: notifier,
      }).resolveDeliveries(message);
      for (const d of deliveries) await d.send();
      return { message, targets: deliveries.map((d) => d.target) };
    };

    it('reaches nobody until an ADMIN chooses it', async () => {
      expect((await deliver()).targets).toEqual([]);
    });

    it('is chosen by the ADMIN in chat, with the warning, and audited at delivery', async () => {
      const say = chat('admin', 'ADMIN');
      const on = await say('attiva export pianificato');
      expect(on).toContain("Riceverai qui l'export pianificato");
      expect(on).toContain('cronologia di questa chat');
      expect(await say('attiva export pianificato')).toContain('già');

      const { message, targets } = await deliver();
      expect(targets).toEqual([`telegram:${telegram.admin}`]);
      expect(sent).toEqual([telegram.admin]);
      const delivered = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId, eventType: 'EXPORT_DELIVERED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(delivered.payload).toEqual({
        channel: 'telegram',
        recipientUserId: users.admin,
        outboxMessageId: message.id,
        rows: 3,
      });
      expect(await auditCount('SCHEDULED_EXPORT_ENABLED')).toBe(1);
    });

    it('is never chosen by a MEMBER, nor on behalf of someone else', async () => {
      expect(await chat('member', 'MEMBER')('attiva export pianificato')).toContain(
        'Solo gli amministratori',
      );
      const forOther = await app.inject({
        method: 'POST',
        url: `/members/${users.admin2}/scheduled-export`,
        headers: authHeaders(tenantId, users.admin, 'ADMIN'),
        payload: { enabled: true },
      });
      expect(forOther.statusCode).toBe(409);
      expect((await deliver()).targets).toEqual([`telegram:${telegram.admin}`]);
    });

    it('stops when another ADMIN turns it off or the membership is revoked', async () => {
      const off = await app.inject({
        method: 'POST',
        url: `/members/${users.admin}/scheduled-export`,
        headers: authHeaders(tenantId, users.admin2, 'ADMIN'),
        payload: { enabled: false },
      });
      expect(off.statusCode).toBe(200);
      expect((await deliver()).targets).toEqual([]);

      await chat('admin', 'ADMIN')('attiva export pianificato');
      await revokeMembership(prisma, tenantId, users.admin, { userId: users.admin2 });
      expect((await deliver()).targets).toEqual([]);
      const membership = await prisma.membership.findUniqueOrThrow({
        where: { userId_orgId: { userId: users.admin, orgId: tenantId } },
      });
      expect(membership.scheduledExportSince).toBeNull();
    });
  });
});
