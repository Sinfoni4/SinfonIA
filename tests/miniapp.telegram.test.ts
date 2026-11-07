/**
 * Telegram Mini App: the opening signed by Telegram logs in only the person whose Telegram account
 * is linked; tampered, foreign or old data is refused. The «Oggi» and «Agenda» summary stays within
 * the caller's grants; «Parla con un operatore» works from the app too.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { SimulatedEmailSender } from '../src/core/email/email.sender.js';
import { LoginService } from '../src/core/identity/login.service.js';
import {
  signWebAppInitData,
  TelegramWebAppError,
  verifyWebAppInitData,
} from '../src/core/identity/telegram-webapp.js';
import { createDocumentRequest } from '../src/core/practice/document-request.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, TEST_AUTH_SECRET, testPrincipals } from './helpers/auth.js';

import type { MiniAppSummary } from '../src/core/miniapp/miniapp.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const BOT = '123456:TEST-bot-token';

describe('the signature of a Mini App opening', () => {
  const now = new Date('2026-11-07T10:00:00Z');

  it('accepts genuine and recent data, with the numeric id only', () => {
    const data = signWebAppInitData(BOT, '424242', now);
    expect(verifyWebAppInitData(data, BOT, now)).toEqual({ telegramId: '424242' });
  });

  it('refuses tampered data, another bot, old data and garbage', () => {
    const data = signWebAppInitData(BOT, '424242', now);
    const tampered = data.replace('424242', '999999');
    expect(() => verifyWebAppInitData(tampered, BOT, now)).toThrow(TelegramWebAppError);
    expect(() => verifyWebAppInitData(data, '654321:OTHER', now)).toThrow(TelegramWebAppError);
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    expect(() => verifyWebAppInitData(data, BOT, later)).toThrow(TelegramWebAppError);
    expect(() => verifyWebAppInitData('user=1&hash=zz', BOT, now)).toThrow(TelegramWebAppError);
    expect(() => verifyWebAppInitData(data, '', now)).toThrow(TelegramWebAppError);
  });
});

describe.runIf(Boolean(DATABASE_URL))('Telegram Mini App', () => {
  const run = randomUUID().slice(0, 8);
  const telegramId = `9${run.replace(/\D/g, '1').slice(0, 7)}`;
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId = '';
  let adminId = '';
  let farmerId = '';
  let otherId = '';
  let practiceId = '';

  const cookieOf = (res: { headers: Record<string, string | string[] | number | undefined> }) => {
    const header = res.headers['set-cookie'];
    const text = Array.isArray(header)
      ? header.join(';')
      : typeof header === 'string'
        ? header
        : '';
    return /sinfonia_refresh=([^;]*)/.exec(text)?.[1] ?? '';
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Azienda ${run}`, module: 'agri' })
    ).id;
    const users = new UserRepository(prisma);
    adminId = (
      await users.createUser(orgId, { email: `admin-${run}@miniapp.local`, role: 'ADMIN' })
    ).id;
    farmerId = (
      await users.createUser(orgId, { email: `anna-${run}@miniapp.local`, role: 'MEMBER' })
    ).id;
    otherId = (
      await users.createUser(orgId, { email: `luca-${run}@miniapp.local`, role: 'MEMBER' })
    ).id;
    await prisma.channelIdentity.create({
      data: {
        userId: farmerId,
        channel: 'TELEGRAM',
        externalId: telegramId,
        verifiedAt: new Date(),
      },
    });

    const practices = new PracticeApplicationService(prisma);
    practiceId = (
      await practices.createPractice({
        tenantId: orgId,
        userId: adminId,
        holderUserId: farmerId,
        name: `Domanda PAC ${run}`,
      })
    ).id;
    // Someone else's practice: never in Anna's summary.
    await practices.createPractice({ tenantId: orgId, userId: otherId, name: `Altra ${run}` });
    await createDocumentRequest(prisma, {
      tenantId: orgId,
      practiceId,
      expectedKey: 'identity',
      message: 'Serve la carta d’identità',
      dueDate: '2026-12-01',
      actorUserId: adminId,
      requesterOrgId: orgId,
      channel: 'dashboard',
    });
    const compliance = new ComplianceService(prisma);
    await compliance.createDeadline({
      tenantId: orgId,
      createdBy: adminId,
      userId: farmerId,
      category: 'DURC',
      title: `DURC ${run}`,
      dueDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3021',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-miniapp',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
      AUTH_EMAIL_LOGIN: 'true',
      ...TEST_AUTH_ENV,
    });
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      login: new LoginService(prisma, new SimulatedEmailSender(), TEST_AUTH_SECRET),
      telegramBotToken: BOT,
      complianceService: compliance,
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

  it('logs in the linked person from a signed opening, as a dashboard session', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/auth/telegram-webapp',
      payload: { initData: signWebAppInitData(BOT, telegramId) },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json<{ data: { userId: string } }>().data.userId).toBe(farmerId);
    const refresh = cookieOf(opened);
    expect(refresh).not.toBe('');
    const token = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { orgId },
      headers: { cookie: `sinfonia_refresh=${refresh}` },
    });
    expect(token.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, userId: farmerId, eventType: 'LOGIN_SUCCEEDED' },
    });
    expect(audit.payload).toMatchObject({ channel: 'telegram' });
  });

  it('refuses an unlinked account, a forged opening and the development route', async () => {
    const unlinked = await app.inject({
      method: 'POST',
      url: '/auth/telegram-webapp',
      payload: { initData: signWebAppInitData(BOT, '777000111') },
    });
    expect(unlinked.statusCode).toBe(401);
    const forged = await app.inject({
      method: 'POST',
      url: '/auth/telegram-webapp',
      payload: { initData: signWebAppInitData('999:WRONG', telegramId) },
    });
    expect(forged.statusCode).toBe(401);
    expect(cookieOf(forged)).toBe('');
    // The signed preview exists only on a development server.
    const dev = await app.inject({
      method: 'POST',
      url: '/auth/telegram-webapp/dev',
      payload: { telegramId },
    });
    expect(dev.statusCode).toBe(404);
  });

  it('gives the person a summary of their own practices, requests and deadlines', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/miniapp/summary',
      headers: authHeaders(orgId, farmerId, 'MEMBER'),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json<{ data: MiniAppSummary }>().data;
    expect(s.practices.map((p) => p.name)).toEqual([`Domanda PAC ${run}`]);
    expect(s.practices[0].openRequests).toBe(1);
    expect(s.documents.expected).toBeGreaterThan(0);
    expect(s.documents.confirmed).toBe(0);
    expect(s.documents.percent).toBe(0);
    expect(s.requests).toEqual([
      expect.objectContaining({
        practiceId,
        label: "Documento d'identità del titolare",
        dueDate: '2026-12-01',
      }),
    ]);
    expect(s.deadlines.map((d) => d.title)).toEqual([`DURC ${run}`]);
    expect(s.feed.map((f) => f.type)).toEqual(
      expect.arrayContaining(['DOCUMENT_REQUESTED', 'PRACTICE_CREATED']),
    );
    expect(s.feed.every((f) => f.practiceId === practiceId)).toBe(true);
    // Another member sees none of it.
    const other = await app.inject({
      method: 'GET',
      url: '/miniapp/summary',
      headers: authHeaders(orgId, otherId, 'MEMBER'),
    });
    const o = other.json<{ data: MiniAppSummary }>().data;
    expect(o.practices.map((p) => p.name)).toEqual([`Altra ${run}`]);
    expect(o.requests).toEqual([]);
    expect(o.deadlines).toEqual([]);
  });

  it('asks an operator from the app, once while the request is open', async () => {
    const ask = () =>
      app.inject({
        method: 'POST',
        url: '/assistance/requests',
        payload: {},
        headers: authHeaders(orgId, farmerId, 'MEMBER'),
      });
    const first = await ask();
    expect(first.statusCode).toBe(201);
    expect((await ask()).statusCode).toBe(200);
    expect(
      await prisma.assistanceRequest.count({ where: { tenantId: orgId, userId: farmerId } }),
    ).toBe(1);
  });
});
