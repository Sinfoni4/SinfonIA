/**
 * AGX-10 / MF7 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §4.4, variant A; tests #10 and #11): a
 * chat account is linked only with /accedi and a one-time code sent to the person's email, valid
 * from the same chat account; the invite code of an organization no longer links. Expired, reused,
 * other-account and exhausted codes are refused, as is a second link of the same chat account;
 * groups are ignored; a revoked link is no longer recognized.
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
  ChannelLinkError,
  ChannelLinkService,
  shortRef,
} from '../src/core/identity/channel-link.service.js';
import { LoginService } from '../src/core/identity/login.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { TenantNotLinkedError } from '../src/core/tenant/tenant.errors.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import {
  ChatLinkFlow,
  LEGACY_LINK_TEXT,
  type ChannelLinkPort,
} from '../src/interface/conversation/chat-link.flow.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { buildServer } from '../src/interface/http/server.js';
import {
  attachMessageHandler,
  createTelegramIdentityProvider,
} from '../src/interface/telegram/telegram.bot.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { TelegramClient, TelegramMessage } from '../src/interface/telegram/telegram.client.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = 'x'.repeat(40);
const codeIn = (text: string | undefined) => /\b(\d{6})\b/.exec(text ?? '')?.[1] ?? '';

describe('the chat side of the link', () => {
  const replies: string[] = [];
  const reply = (text: string) => {
    replies.push(text);
    return Promise.resolve();
  };
  const port = {
    start: vi.fn(() => Promise.resolve({ challengeId: randomUUID() })),
    verify: vi.fn(),
    isLinked: vi.fn(() => Promise.resolve(false)),
    revokeFromChat: vi.fn(() => Promise.resolve(true)),
    listFromChat: vi.fn(() => Promise.resolve(null)),
  } satisfies ChannelLinkPort;

  it('refuses the old invite code of an organization, pointing to /accedi', async () => {
    const flow = new ChatLinkFlow(port, 'TELEGRAM', () => Promise.resolve('benvenuto'));
    expect(await flow.handle('42', 'start ABC123', reply)).toBe(true);
    expect(replies.at(-1)).toBe(LEGACY_LINK_TEXT);
    expect(port.start).not.toHaveBeenCalled();
    // A plain message of someone not in a flow is left to the conversation.
    expect(await flow.handle('42', 'ciao', reply)).toBe(false);
  });

  it('asks the email, then the code, and welcomes after a valid one', async () => {
    const flow = new ChatLinkFlow(port, 'TELEGRAM', () => Promise.resolve('benvenuto'));
    await flow.handle('42', '/accedi', reply);
    expect(replies.at(-1)).toContain('Scrivi l’email');
    await flow.handle('42', 'non è una email', reply);
    expect(replies.at(-1)).toContain('Non sembra un’email');
    await flow.handle('42', 'anna@azienda.it', reply);
    expect(port.start).toHaveBeenCalledWith({
      channel: 'TELEGRAM',
      externalId: '42',
      email: 'anna@azienda.it',
    });
    expect(replies.at(-1)).toContain('codice di 6 cifre');
    await flow.handle('42', 'boh', reply);
    expect(replies.at(-1)).toContain('Scrivi il codice di 6 cifre');
    port.verify.mockRejectedValueOnce(new ChannelLinkError());
    await flow.handle('42', '111111', reply);
    expect(replies.at(-1)).toContain('Codice non valido o scaduto');
    port.verify.mockResolvedValueOnce({ userId: 'u', organizations: [] });
    await flow.handle('42', '222222', reply);
    expect(replies.at(-1)).toBe('benvenuto');
    // The flow is over: a code now is just a message.
    expect(await flow.handle('42', '333333', reply)).toBe(false);
  });

  it('says linking is not available where email login is off', async () => {
    const flow = new ChatLinkFlow(undefined, 'TELEGRAM', () => Promise.resolve(''));
    await flow.handle('42', '/accedi', reply);
    expect(replies.at(-1)).toContain('non è ancora attivo');
  });
});

describe('Telegram groups', () => {
  it('ignores messages and buttons outside private chats', async () => {
    const listeners = new Map<string, (value: never) => Promise<void>>();
    const bot = {
      on: (event: string, cb: (value: never) => Promise<void>) => {
        listeners.set(event, cb);
        return bot;
      },
      sendMessage: vi.fn(() => Promise.resolve({ message_id: 1 })),
      answerCallbackQuery: vi.fn(() => Promise.resolve()),
      clearInlineKeyboard: vi.fn(() => Promise.resolve()),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const handleMessage = vi.fn(() => Promise.resolve('fatto'));
    attachMessageHandler(bot as unknown as TelegramClient, {
      prisma: {} as PrismaClient,
      identity: { resolve: () => Promise.reject(new TenantNotLinkedError()) },
      practiceService: { executeCommand: vi.fn() },
      handleMessage,
    });
    const message = listeners.get('message') as unknown as (m: TelegramMessage) => Promise<void>;
    await message({
      message_id: 1,
      date: 0,
      text: '/accedi',
      chat: { id: -100, type: 'group' },
      from: { id: 42, is_bot: false },
    });
    expect(bot.sendMessage).not.toHaveBeenCalled();
    await message({
      message_id: 2,
      date: 0,
      text: 'ciao',
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false },
    });
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(Boolean(DATABASE_URL))('verified chat link (AGX-10)', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  const tg = { anna: `81${digits}1`, other: `82${digits}2`, bruno: `83${digits}3` };
  const email = { anna: `anna-${run}@agx10.local`, bruno: `bruno-${run}@agx10.local` };
  let prisma: PrismaClient;
  let mail: SimulatedEmailSender;
  let links: ChannelLinkService;
  let app: ReturnType<typeof buildServer>;
  let orgId = '';
  let otherOrgId = '';
  let adminId = '';
  let now = Date.now();

  const start = (externalId: string, address: string) =>
    links.start({ channel: 'TELEGRAM', externalId, email: address });
  const verify = (externalId: string, challengeId: string, code: string) =>
    links.verify({ channel: 'TELEGRAM', externalId, challengeId, code });
  const resolveTelegram = (externalId: string) =>
    createTelegramIdentityProvider(prisma).resolve(externalId);

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    mail = new SimulatedEmailSender();
    links = new ChannelLinkService(prisma, mail, SECRET, { now: () => new Date(now) });
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    otherOrgId = (await tenants.createTenant({ name: `Altra ${run}` })).id;
    adminId = (
      await new UserRepository(prisma).createUser(orgId, {
        email: `admin-${run}@agx10.local`,
        role: 'ADMIN',
      })
    ).id;
    // Anna is invited by email by the administrator, as a member.
    const login = new LoginService(prisma, mail, SECRET);
    await login.createInvitation(orgId, email.anna, 'MEMBER', { userId: adminId });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3019',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-agx10',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      channelLinks: links,
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

  it('sends nothing for an unknown email, with the same answer', async () => {
    const before = mail.sent.length;
    const started = await start(tg.other, `nessuno-${run}@agx10.local`);
    expect(started.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mail.sent.length).toBe(before);
    await expect(verify(tg.other, started.challengeId, '123456')).rejects.toThrow(ChannelLinkError);
  });

  it('accepts the invitation and links Telegram only from the same account (#10)', async () => {
    const { challengeId } = await start(tg.anna, email.anna);
    const code = codeIn(mail.lastTo(email.anna)?.text);
    expect(code).toHaveLength(6);

    // The same code typed from another Telegram account: refused, and the attempt counts.
    await expect(verify(tg.other, challengeId, code)).rejects.toThrow(ChannelLinkError);
    // A wrong code from the right account: refused.
    await expect(
      verify(tg.anna, challengeId, code === '000000' ? '000001' : '000000'),
    ).rejects.toThrow(ChannelLinkError);
    const linked = await verify(tg.anna, challengeId, code);
    expect(linked.organizations).toEqual([{ orgId, name: `Azienda ${run}` }]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: linked.userId } });
    expect(user.email).toBe(email.anna);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await prisma.membership.findFirstOrThrow({ where: { userId: user.id, orgId } }),
    ).toMatchObject({ role: 'MEMBER', status: 'ACTIVE' });
    expect(await prisma.invitation.count({ where: { email: email.anna, acceptedAt: null } })).toBe(
      0,
    );
    const identity = await prisma.channelIdentity.findFirstOrThrow({
      where: { channel: 'TELEGRAM', externalId: tg.anna, revokedAt: null },
    });
    expect(identity.userId).toBe(user.id);
    expect(identity.verifiedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'CHANNEL_LINKED', userId: user.id },
    });
    expect(audit.payload).toEqual({ channel: 'TELEGRAM', ref: shortRef(tg.anna) });
    expect(JSON.stringify(audit.payload)).not.toContain(tg.anna);
    expect(mail.lastTo(email.anna)?.subject).toBe('Telegram collegato a SinfonIA');

    // The bot now knows Anna; the used code is gone.
    expect((await resolveTelegram(tg.anna)).userId).toBe(user.id);
    await expect(verify(tg.anna, challengeId, code)).rejects.toThrow(ChannelLinkError);
    // An already linked account asks for nothing more.
    await expect(start(tg.anna, email.anna)).rejects.toThrow('già collegato');
  });

  it('refuses expired codes and codes after five wrong attempts', async () => {
    await new UserRepository(prisma).createUser(orgId, { email: email.bruno, role: 'OPERATOR' });
    const first = await start(tg.bruno, email.bruno);
    const code = codeIn(mail.lastTo(email.bruno)?.text);
    now += 11 * 60_000;
    await expect(verify(tg.bruno, first.challengeId, code)).rejects.toThrow(ChannelLinkError);
    now = Date.now();

    const second = await start(tg.bruno, email.bruno);
    const good = codeIn(mail.lastTo(email.bruno)?.text);
    const wrong = good === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i++) {
      await expect(verify(tg.bruno, second.challengeId, wrong)).rejects.toThrow(ChannelLinkError);
    }
    await expect(verify(tg.bruno, second.challengeId, good)).rejects.toThrow(ChannelLinkError);
    await expect(resolveTelegram(tg.bruno)).rejects.toThrow(TenantNotLinkedError);
  });

  it('never links the same chat account twice, even when two people race', async () => {
    // Bruno and Carla both ask from the same Telegram account; Bruno confirms first.
    const carla = `carla-${run}@agx10.local`;
    await new UserRepository(prisma).createUser(orgId, { email: carla, role: 'MEMBER' });
    const shared = `84${digits}4`;
    const forBruno = await start(shared, email.bruno);
    const brunoCode = codeIn(mail.lastTo(email.bruno)?.text);
    const forCarla = await start(shared, carla);
    const carlaCode = codeIn(mail.lastTo(carla)?.text);
    await verify(shared, forBruno.challengeId, brunoCode);
    await expect(verify(shared, forCarla.challengeId, carlaCode)).rejects.toThrow('già collegato');
    expect(
      await prisma.channelIdentity.count({
        where: { channel: 'TELEGRAM', externalId: shared, revokedAt: null },
      }),
    ).toBe(1);
  });

  it('lets the person and the administrator revoke a link; the bot forgets it (#11)', async () => {
    const anna = await prisma.user.findFirstOrThrow({ where: { email: email.anna } });
    const asAnna = authHeaders(orgId, anna.id, 'MEMBER');
    const asAdmin = authHeaders(orgId, adminId, 'ADMIN');
    const own = await app.inject({ method: 'GET', url: '/me/channels', headers: asAnna });
    const { links: mine } = own.json<{ data: { links: Array<{ id: string; ref: string }> } }>()
      .data;
    expect(mine).toHaveLength(1);
    expect(mine[0].ref).toBe(shortRef(tg.anna));

    // Another organization's administrator sees and revokes nothing of Anna.
    const outsider = await new UserRepository(prisma).createUser(otherOrgId, {
      email: `admin2-${run}@agx10.local`,
      role: 'ADMIN',
    });
    const asOutsider = authHeaders(otherOrgId, outsider.id, 'ADMIN');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/members/${anna.id}/channels`,
          headers: asOutsider,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/members/${anna.id}/channels/${mine[0].id}/revoke`,
          headers: asOutsider,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    // A member cannot revoke others' links.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/members/${adminId}/channels/${mine[0].id}/revoke`,
          headers: asAnna,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);

    // The administrator of Anna's organization revokes it.
    const listed = await app.inject({
      method: 'GET',
      url: `/members/${anna.id}/channels`,
      headers: asAdmin,
    });
    expect(listed.json<{ data: unknown[] }>().data).toHaveLength(1);
    const revoked = await app.inject({
      method: 'POST',
      url: `/members/${anna.id}/channels/${mine[0].id}/revoke`,
      headers: asAdmin,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    await expect(resolveTelegram(tg.anna)).rejects.toThrow(TenantNotLinkedError);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'CHANNEL_UNLINKED', userId: adminId },
    });
    expect(audit.payload).toMatchObject({
      channel: 'TELEGRAM',
      by: 'admin',
      targetUserId: anna.id,
    });

    // Anna links again, then revokes it herself.
    const again = await start(tg.anna, email.anna);
    await verify(tg.anna, again.challengeId, codeIn(mail.lastTo(email.anna)?.text));
    const [current] = await links.list(anna.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/me/channels/${current.id}/revoke`,
          headers: asAnna,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await expect(resolveTelegram(tg.anna)).rejects.toThrow(TenantNotLinkedError);
  });

  it('runs the whole flow in chat, and ignores the old invite code', async () => {
    const chatId = `85${digits}5`;
    const dana = `dana-${run}@agx10.local`;
    const login = new LoginService(prisma, mail, SECRET);
    await login.createInvitation(orgId, dana, 'MEMBER', { userId: adminId });
    const replies: string[] = [];
    const conversation = new ConversationService(
      {
        practiceService: { executeCommand: vi.fn() },
        handleMessage: () => Promise.resolve('…'),
        channelLinks: links,
      },
      { name: 'telegram', identity: createTelegramIdentityProvider(prisma) },
    );
    const say = async (text: string) => {
      await conversation.handle({ senderId: chatId, text }, (t) => {
        replies.push(t);
        return Promise.resolve();
      });
      return replies.at(-1) ?? '';
    };

    expect(await say('ciao')).toContain('Scrivi /accedi');
    expect(await say('start ABC123')).toBe(LEGACY_LINK_TEXT);
    await say('/accedi');
    expect(await say(dana)).toContain('codice di 6 cifre');
    expect(await say(codeIn(mail.lastTo(dana)?.text))).toContain(
      `✅ Account collegato a Azienda ${run}.`,
    );
    expect(await say('/collegamenti')).toContain(`Telegram ${shortRef(chatId)}`);
    expect(await say('/scollega')).toContain('Vuoi scollegare');
    expect(await say('sì')).toContain('Account scollegato');
    expect(await say('ciao')).toContain('Scrivi /accedi');
  });
});
