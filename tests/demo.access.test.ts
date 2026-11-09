/**
 * Demo access (staging only): the generic link `t.me/<bot>?start=demo` gives an unlinked Telegram
 * account its own account in «SinfonIA Demo» with invented data, never a real organization; a
 * linked account is left alone; visitors do not see each other; old demo accounts are deleted.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { DEMO_ORG_NAME, expireDemoAccounts, startDemo } from '../src/core/demo/demo-access.js';
import { miniAppSummary } from '../src/core/miniapp/miniapp.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import {
  ChatLinkFlow,
  LEGACY_LINK_TEXT,
  NOT_LINKED_TEXT,
} from '../src/interface/conversation/chat-link.flow.js';

import { TEST_AUTH_ENV } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('the demo in the chat', () => {
  const welcome = () => Promise.resolve('');
  const replies: Array<{ text: string; url?: string }> = [];
  const reply = (text: string, options?: { webApp?: { url: string } }) => {
    replies.push({ text, ...(options?.webApp ? { url: options.webApp.url } : {}) });
    return Promise.resolve();
  };

  it('answers the demo link with an account of one’s own and the app', async () => {
    const demo = vi.fn(() =>
      Promise.resolve({ status: 'created' as const, orgName: DEMO_ORG_NAME, days: 7 }),
    );
    const flow = new ChatLinkFlow(undefined, 'TELEGRAM', welcome, Date.now, {
      demo,
      miniAppUrl: 'https://x.example/app/tg',
    });
    expect(await flow.handle('42', '/start demo', reply)).toBe(true);
    expect(demo).toHaveBeenCalledWith('42');
    expect(replies.at(-1)?.text).toContain('Benvenuto nella demo di SinfonIA');
    expect(replies.at(-1)?.url).toBe('https://x.example/app/tg');
    await flow.handle('42', '/demo', reply);
    expect(demo).toHaveBeenCalledTimes(2);
    expect(flow.notLinkedText()).toContain('/demo');
  });

  it('leaves a linked account alone, and offers nothing where the demo is off', async () => {
    const linked = new ChatLinkFlow(undefined, 'TELEGRAM', welcome, Date.now, {
      demo: () => Promise.resolve({ status: 'linked' }),
    });
    await linked.handle('42', '/start demo', reply);
    expect(replies.at(-1)?.text).toContain('già collegato');

    const off = new ChatLinkFlow(undefined, 'TELEGRAM', welcome);
    await off.handle('42', '/start demo', reply);
    expect(replies.at(-1)?.text).toBe(LEGACY_LINK_TEXT);
    expect(off.notLinkedText()).toBe(NOT_LINKED_TEXT);
  });

  it('is refused in production', () => {
    const base = {
      NODE_ENV: 'production',
      PORT: '3023',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/x',
      ...TEST_AUTH_ENV,
    };
    expect(() => loadConfig({ ...base, DEMO_ACCESS: 'true' })).toThrow(/DEMO_ACCESS/);
    expect(loadConfig({ ...base, NODE_ENV: 'development', DEMO_ACCESS: 'true' }).DEMO_ACCESS).toBe(
      true,
    );
  });
});

describe.runIf(Boolean(DATABASE_URL))('demo accounts', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '3').slice(0, 6);
  const ids = { anna: `71${digits}1`, luca: `72${digits}2`, real: `73${digits}3` };
  let prisma: PrismaClient;
  let deps: Parameters<typeof startDemo>[0];

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    deps = {
      prisma,
      practices: new PracticeApplicationService(prisma),
      compliance: new ComplianceService(prisma),
    };
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('gives each visitor their own invented data in the demo organization', async () => {
    expect(await startDemo(deps, ids.anna)).toMatchObject({ status: 'created', days: 7 });
    expect(await startDemo(deps, ids.luca)).toMatchObject({ status: 'created' });

    const org = await prisma.tenant.findFirstOrThrow({ where: { name: DEMO_ORG_NAME } });
    expect(org.disabledFeatures).toEqual(expect.arrayContaining(['ai_chat', 'assistance']));
    const anna = await prisma.channelIdentity.findFirstOrThrow({
      where: { channel: 'TELEGRAM', externalId: ids.anna, revokedAt: null },
      select: { userId: true, user: { select: { memberships: true } } },
    });
    expect(anna.user.memberships.map((m) => [m.orgId, m.role])).toEqual([[org.id, 'MEMBER']]);

    const summary = await miniAppSummary(prisma, new ComplianceService(prisma), {
      tenantId: org.id,
      practiceUserId: anna.userId,
      deadlineUserId: anna.userId,
    });
    expect(summary.practices.map((p) => p.name).sort()).toEqual([
      'Bando PSR 2026',
      'Domanda PAC 2026',
    ]);
    expect(summary.requests).toHaveLength(1);
    expect(summary.deadlines).toHaveLength(2);
    // Luca's practices are not Anna's.
    const lucaId = (
      await prisma.channelIdentity.findFirstOrThrow({
        where: { channel: 'TELEGRAM', externalId: ids.luca, revokedAt: null },
      })
    ).userId;
    const annaPractices = await prisma.practice.findMany({
      where: { tenantId: org.id, holderUserId: anna.userId },
      select: { id: true },
    });
    const lucaPractices = await prisma.practice.findMany({
      where: { tenantId: org.id, holderUserId: lucaId },
      select: { id: true },
    });
    expect(annaPractices).toHaveLength(2);
    expect(lucaPractices.some((p) => annaPractices.some((a) => a.id === p.id))).toBe(false);
  });

  it('never moves a linked account, demo or real, into a new demo account', async () => {
    expect(await startDemo(deps, ids.anna)).toEqual({ status: 'linked' });
    const realOrg = (await new TenantRepository(prisma).createTenant({ name: `Vera ${run}` })).id;
    await new UserRepository(prisma).createUser(realOrg, {
      email: `vera-${run}@demo.local`,
      role: 'ADMIN',
      telegramId: ids.real,
    });
    expect(await startDemo(deps, ids.real)).toEqual({ status: 'linked' });
  });

  it('deletes demo accounts and their data after a week, and nothing else', async () => {
    const deleted: string[] = [];
    const storage = {
      delete: (_tenant: string, storagePath: string) => {
        deleted.push(storagePath);
        return Promise.resolve();
      },
    };
    // Not yet: they were created now.
    expect(await expireDemoAccounts(prisma, storage)).toBe(0);
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await expireDemoAccounts(prisma, storage, later)).toBeGreaterThanOrEqual(2);
    expect(deleted.length).toBeGreaterThanOrEqual(6);
    for (const id of [ids.anna, ids.luca]) {
      expect(
        await prisma.channelIdentity.count({ where: { channel: 'TELEGRAM', externalId: id } }),
      ).toBe(0);
    }
    // The real account, and the demo administrator, stay.
    expect(
      await prisma.channelIdentity.count({
        where: { channel: 'TELEGRAM', externalId: ids.real, revokedAt: null },
      }),
    ).toBe(1);
    expect(await prisma.user.count({ where: { email: 'demo.admin@sinfonia.test' } })).toBe(1);
  });
});
