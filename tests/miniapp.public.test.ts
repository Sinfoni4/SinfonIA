/**
 * Telegram Mini App on a public address: its login works without email login (no email routes,
 * invitations or console then), the public staging takes only a clean https address, and the chat
 * offers the app with a Telegram Mini App button, only over https.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { checkPublicUrl } from '../scripts/staging/public-url.js';
import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { SimulatedEmailSender } from '../src/core/email/email.sender.js';
import { LoginService } from '../src/core/identity/login.service.js';
import { signWebAppInitData } from '../src/core/identity/telegram-webapp.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { replyMarkup } from '../src/interface/telegram/telegram.bot.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, TEST_AUTH_SECRET, testPrincipals } from './helpers/auth.js';

import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { ReplyOptions } from '../src/interface/conversation/conversation.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const BOT = '123456:TEST-bot-token';

describe('the address of the public staging', () => {
  it('takes only https, without path, parameters or credentials', () => {
    expect(checkPublicUrl('https://prova.trycloudflare.com')).toBe(
      'https://prova.trycloudflare.com',
    );
    expect(() => checkPublicUrl(undefined)).toThrow(/--public-url/);
    expect(() => checkPublicUrl('http://prova.example')).toThrow(/https/);
    expect(() => checkPublicUrl('https://user:pw@prova.example')).toThrow(/credenziali/);
    expect(() => checkPublicUrl('https://prova.example/?x=1')).toThrow();
    expect(() => checkPublicUrl('https://prova.example/app')).toThrow(/percorso/);
    expect(() => checkPublicUrl('not a url')).toThrow(/non valido/);
  });
});

describe('the Mini App button in Telegram', () => {
  it('opens the app only from an https address', () => {
    expect(replyMarkup({ webApp: { label: 'Apri', url: 'https://x.example/app/tg' } })).toEqual({
      inline_keyboard: [[{ text: 'Apri', web_app: { url: 'https://x.example/app/tg' } }]],
    });
    expect(
      replyMarkup({ webApp: { label: 'Apri', url: 'http://localhost/app/tg' } }),
    ).toBeUndefined();
  });

  it('is offered by /app and after /start, and not where the app is not available', async () => {
    const tenant = {
      id: 't-1',
      name: 'Azienda',
      module: 'agri',
      disabledFeatures: [],
    } as unknown as Tenant;
    const chat = (miniAppUrl?: string) => {
      const replies: Array<{ text: string; options?: ReplyOptions }> = [];
      const conversation = new ConversationService(
        { practiceService: { executeCommand: vi.fn() }, handleMessage: () => Promise.resolve('…') },
        {
          name: 'telegram',
          identity: {
            resolve: () =>
              Promise.resolve({ tenant, userId: 'u-1', role: 'MEMBER', customPermissions: null }),
          },
          ...(miniAppUrl ? { miniAppUrl } : {}),
        },
      );
      const say = (text: string) =>
        conversation.handle({ senderId: '42', text }, (t, options) => {
          replies.push({ text: t, ...(options ? { options } : {}) });
          return Promise.resolve();
        });
      return { replies, say };
    };

    const on = chat('https://x.example/app/tg');
    await on.say('/app');
    expect(on.replies.at(-1)?.options?.webApp).toEqual({
      label: '📱 Apri SinfonIA',
      url: 'https://x.example/app/tg',
    });
    await on.say('/start');
    expect(on.replies.at(-1)?.options?.webApp?.url).toBe('https://x.example/app/tg');

    const off = chat();
    await off.say('/app');
    expect(off.replies.at(-1)?.text).toContain('non è ancora disponibile');
    expect(off.replies.at(-1)?.options).toBeUndefined();
    await off.say('/start');
    expect(off.replies.every((r) => !r.options?.webApp)).toBe(true);
  });
});

describe.runIf(Boolean(DATABASE_URL))('Mini App login without email login', () => {
  const run = randomUUID().slice(0, 8);
  const telegramId = `8${run.replace(/\D/g, '2').slice(0, 7)}`;
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId = '';
  let adminId = '';

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Azienda ${run}`, module: 'agri' })
    ).id;
    const users = new UserRepository(prisma);
    adminId = (await users.createUser(orgId, { email: `admin-${run}@public.local`, role: 'ADMIN' }))
      .id;
    const farmer = await users.createUser(orgId, {
      email: `anna-${run}@public.local`,
      role: 'MEMBER',
    });
    await prisma.channelIdentity.create({
      data: {
        userId: farmer.id,
        channel: 'TELEGRAM',
        externalId: telegramId,
        verifiedAt: new Date(),
      },
    });
    // As `npm run staging:start -- --public` runs it: Mini App on, email login off.
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3022',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-public',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
      TELEGRAM_MINIAPP: 'true',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      login: new LoginService(prisma, new SimulatedEmailSender(), TEST_AUTH_SECRET),
      emailLogin: false,
      telegramBotToken: BOT,
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

  it('logs in a linked Telegram account and refreshes its token', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/auth/telegram-webapp',
      payload: { initData: signWebAppInitData(BOT, telegramId) },
    });
    expect(opened.statusCode).toBe(200);
    const cookie = String(opened.headers['set-cookie'] ?? '');
    const refresh = /sinfonia_refresh=([^;]*)/.exec(cookie)?.[1] ?? '';
    const token = await app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { orgId },
      headers: { cookie: `sinfonia_refresh=${refresh}` },
    });
    expect(token.statusCode).toBe(200);
  });

  it('offers no email login, invitation, console token or signed preview', async () => {
    const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url, payload, headers });
    expect(
      (await post('/auth/login/start', { email: `admin-${run}@public.local` })).statusCode,
    ).toBe(404);
    expect((await post('/auth/invitations/start', { token: 'x'.repeat(30) })).statusCode).toBe(404);
    expect((await post('/auth/platform-token', {})).statusCode).toBe(404);
    expect((await post('/auth/telegram-webapp/dev', { telegramId })).statusCode).toBe(404);
    // Invitations go by email: the administrators cannot send them here.
    const invite = await post(
      '/members/invitations',
      { email: `nuovo-${run}@public.local`, role: 'MEMBER' },
      authHeaders(orgId, adminId, 'ADMIN'),
    );
    expect(invite.statusCode).toBe(404);
  });
});
