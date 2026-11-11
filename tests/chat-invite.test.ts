/**
 * Personal Telegram links (variant B, §4.4): an administrator invites a new person with a
 * single-use t.me link, and a person links their own Telegram from the dashboard; no email needed.
 * Used once, expiring, revocable, never across organizations, never accepted on the web.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { SimulatedEmailSender } from '../src/core/email/email.sender.js';
import {
  ChatInviteError,
  ChatInviteService,
  CHAT_INVITE_TTL_MS,
} from '../src/core/identity/chat-invite.service.js';
import { LoginService } from '../src/core/identity/login.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ChatLinkFlow, LEGACY_LINK_TEXT } from '../src/interface/conversation/chat-link.flow.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, TEST_AUTH_SECRET, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('personal links in the chat', () => {
  const token = `i${'a'.repeat(32)}`;
  const replies: Array<{ text: string; url?: string }> = [];
  const reply = (text: string, options?: { webApp?: { url: string } }) => {
    replies.push({ text, ...(options?.webApp ? { url: options.webApp.url } : {}) });
    return Promise.resolve();
  };

  it('opens a personal link and welcomes, or explains a used one', async () => {
    const redeem = vi
      .fn()
      .mockResolvedValueOnce({ userId: 'u', organizations: [{ orgId: 'o', name: 'Azienda' }] })
      .mockRejectedValueOnce(new ChatInviteError());
    const flow = new ChatLinkFlow(
      undefined,
      'TELEGRAM',
      () => Promise.resolve('benvenuto'),
      Date.now,
      {
        invites: { redeem },
        miniAppUrl: 'https://x.example/app/tg',
      },
    );
    expect(await flow.handle('42', `/start ${token}`, reply)).toBe(true);
    expect(redeem).toHaveBeenCalledWith('42', token);
    expect(replies.at(-1)).toEqual({ text: 'benvenuto', url: 'https://x.example/app/tg' });
    await flow.handle('42', `/start ${token}`, reply);
    expect(replies.at(-1)?.text).toContain('Link non valido o scaduto');
    // Anything else after /start is not a personal link.
    await flow.handle('42', '/start ABC123', reply);
    expect(replies.at(-1)?.text).toBe(LEGACY_LINK_TEXT);
  });
});

describe.runIf(Boolean(DATABASE_URL))('personal Telegram links', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '4').slice(0, 6);
  const tg = {
    anna: `61${digits}1`,
    bruno: `62${digits}2`,
    carla: `63${digits}3`,
    dino: `64${digits}4`,
  };
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let invites: ChatInviteService;
  let now = Date.now();
  let orgId = '';
  let otherOrgId = '';
  let adminId = '';
  let memberId = '';
  let otherAdminId = '';

  const create = (role = 'MEMBER', headers = authHeaders(orgId, adminId, 'ADMIN')) =>
    app.inject({ method: 'POST', url: '/members/chat-invites', payload: { role }, headers });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    otherOrgId = (await tenants.createTenant({ name: `Altra ${run}` })).id;
    const users = new UserRepository(prisma);
    adminId = (await users.createUser(orgId, { email: `admin-${run}@invite.local`, role: 'ADMIN' }))
      .id;
    memberId = (
      await users.createUser(orgId, { email: `socio-${run}@invite.local`, role: 'MEMBER' })
    ).id;
    otherAdminId = (
      await users.createUser(otherOrgId, { email: `admin2-${run}@invite.local`, role: 'ADMIN' })
    ).id;
    invites = new ChatInviteService(prisma, 'sinfonia_test_bot', { now: () => new Date(now) });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3024',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-invite',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      chatInvites: invites,
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

  it('lets an administrator invite a new person who enters by opening the link', async () => {
    expect((await create('MEMBER', authHeaders(orgId, memberId, 'MEMBER'))).statusCode).toBe(403);
    const res = await create('OPERATOR');
    expect(res.statusCode).toBe(201);
    const issued = res.json<{ data: { token: string; link: string } }>().data;
    expect(issued.link).toBe(`https://t.me/sinfonia_test_bot?start=${issued.token}`);
    expect(issued.token).toMatch(/^i[A-Za-z0-9_-]{32}$/);

    const result = await invites.redeem(tg.anna, issued.token);
    expect(result.organizations).toEqual([{ orgId, name: `Azienda ${run}` }]);
    const identity = await prisma.channelIdentity.findFirstOrThrow({
      where: { channel: 'TELEGRAM', externalId: tg.anna, revokedAt: null },
      select: { userId: true, verifiedAt: true, user: { select: { email: true } } },
    });
    expect(identity.verifiedAt).not.toBeNull();
    expect(identity.user.email).toMatch(/^telegram-.+@local\.invalid$/);
    expect(
      await prisma.membership.findFirstOrThrow({ where: { userId: identity.userId, orgId } }),
    ).toMatchObject({ role: 'OPERATOR', status: 'ACTIVE' });
    const audit = await prisma.auditLog.findMany({
      where: { tenantId: orgId, userId: identity.userId },
      select: { eventType: true, payload: true },
    });
    expect(audit.map((a) => a.eventType).sort()).toEqual(['CHANNEL_LINKED', 'INVITATION_ACCEPTED']);
    expect(JSON.stringify(audit)).not.toContain(tg.anna);

    // Once only, whoever opens it again.
    await expect(invites.redeem(tg.bruno, issued.token)).rejects.toThrow(ChatInviteError);
    const list = await app.inject({
      method: 'GET',
      url: '/members/chat-invites',
      headers: authHeaders(orgId, adminId, 'ADMIN'),
    });
    expect(list.json<{ data: Array<{ status: string }> }>().data[0].status).toBe('ACCEPTED');
  });

  it('refuses revoked, expired and foreign invitations', async () => {
    const revoked = (await create()).json<{ data: { token: string } }>().data.token;
    const pending = await invites.listInvites(orgId);
    const id = pending.find((p) => p.status === 'PENDING')!.id;
    // Another organization's administrator cannot revoke it.
    const foreign = await app.inject({
      method: 'POST',
      url: `/members/chat-invites/${id}/revoke`,
      payload: {},
      headers: authHeaders(otherOrgId, otherAdminId, 'ADMIN'),
    });
    expect(foreign.statusCode).toBe(404);
    const done = await app.inject({
      method: 'POST',
      url: `/members/chat-invites/${id}/revoke`,
      payload: {},
      headers: authHeaders(orgId, adminId, 'ADMIN'),
    });
    expect(done.statusCode).toBe(200);
    await expect(invites.redeem(tg.bruno, revoked)).rejects.toThrow(ChatInviteError);

    const old = (await create()).json<{ data: { token: string } }>().data.token;
    now += CHAT_INVITE_TTL_MS + 60_000;
    await expect(invites.redeem(tg.bruno, old)).rejects.toThrow(ChatInviteError);
    now = Date.now();
    await expect(invites.redeem(tg.bruno, `i${'x'.repeat(32)}`)).rejects.toThrow(ChatInviteError);
  });

  it('adds a membership, not a second person, for an account already linked', async () => {
    const other = await new UserRepository(prisma).createUser(otherOrgId, {
      email: `carla-${run}@invite.local`,
      role: 'ADMIN',
      telegramId: tg.carla,
    });
    const token = (await create('MEMBER')).json<{ data: { token: string } }>().data.token;
    const result = await invites.redeem(tg.carla, token);
    expect(result.userId).toBe(other.id);
    expect(result.organizations.map((o) => o.orgId).sort()).toEqual([orgId, otherOrgId].sort());
  });

  it('links one’s own Telegram from the dashboard, once and only for that person', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/channels/link',
      payload: {},
      headers: authHeaders(orgId, memberId, 'MEMBER'),
    });
    expect(res.statusCode).toBe(201);
    const own = res.json<{ data: { token: string } }>().data.token;
    expect(own).toMatch(/^l/);
    // Not from an account already linked to someone else.
    await expect(invites.redeem(tg.anna, own)).rejects.toThrow('già collegato');
    const linked = await invites.redeem(tg.dino, own);
    expect(linked.userId).toBe(memberId);
    expect(
      await prisma.channelIdentity.count({
        where: { channel: 'TELEGRAM', externalId: tg.dino, userId: memberId, revokedAt: null },
      }),
    ).toBe(1);
    await expect(invites.redeem(tg.dino, own)).rejects.toThrow(ChatInviteError);
  });

  it('keeps Telegram invitations out of the email ones', async () => {
    const token = (await create()).json<{ data: { token: string } }>().data.token;
    const login = new LoginService(prisma, new SimulatedEmailSender(), TEST_AUTH_SECRET);
    expect(
      (await login.listInvitations(orgId)).every((i) => !i.email.includes('invito-telegram')),
    ).toBe(true);
    await expect(login.startInvitation(token)).rejects.toThrow(/Invito non valido/);
  });
});
