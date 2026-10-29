/**
 * MF4 (switch step): people belong to organizations through memberships. One person, one
 * Telegram account, two organizations with different roles; revocation and suspension through
 * statuses. docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2, §5.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaPrincipalResolver } from '../src/core/authz/authorization.service.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { chatRecipients } from '../src/core/identity/membership.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { registerInviteCode } from '../src/core/tenant/tenant.invite.store.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { createTelegramIdentityProvider } from '../src/interface/telegram/telegram.bot.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('MF4 memberships', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let tenantA: { id: string; name: string };
  let tenantB: { id: string; name: string };
  let userId: string;
  const telegramId = String(700000000 + Math.floor(Math.random() * 99999999));
  const inviteB = `invito-b-${run}`;

  const chat = () => {
    const replies: string[] = [];
    const service = new ConversationService(
      {
        practiceService: new PracticeApplicationService(prisma),
        complianceService: new ComplianceService(prisma),
        handleMessage: () => Promise.resolve('ai'),
      },
      { name: 'telegram', identity: createTelegramIdentityProvider(prisma) },
    );
    return {
      replies,
      say: (text: string) =>
        service.handle({ senderId: telegramId, text }, (t) => {
          replies.push(t);
          return Promise.resolve();
        }),
      last: () => replies.at(-1) ?? '',
    };
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    tenantA = await tenants.createTenant({ name: `Cooperativa A ${run}` });
    tenantB = await tenants.createTenant({ name: `Cooperativa B ${run}` });
    await registerInviteCode(prisma, inviteB, tenantB.id);
    // Legacy account in A, made an ADMIN there.
    userId = (await new UserRepository(prisma).ensureTelegramUser(tenantA.id, telegramId)).id;
    await prisma.membership.update({
      where: { userId_orgId: { userId, orgId: tenantA.id } },
      data: { role: 'ADMIN' },
    });
    const practices = new PracticeApplicationService(prisma);
    await practices.createPractice({
      tenantId: tenantA.id,
      userId,
      name: `Pratica A ${run}`,
      kind: 'music',
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('joins a second organization with the same account: a membership, not a new person', async () => {
    const provider = createTelegramIdentityProvider(prisma);
    expect(await provider.link(inviteB, telegramId)).toBe(tenantB.id);
    expect(await prisma.user.count({ where: { telegramId } })).toBe(1);
    const memberships = await prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(memberships.map((m) => [m.orgId, m.role, m.status])).toEqual([
      [tenantA.id, 'ADMIN', 'ACTIVE'],
      [tenantB.id, 'MEMBER', 'ACTIVE'],
    ]);
    await new PracticeApplicationService(prisma).createPractice({
      tenantId: tenantB.id,
      userId,
      name: `Pratica B ${run}`,
      kind: 'music',
    });
  });

  it('asks which organization to use, then works with the role of the chosen one', async () => {
    const c = chat();
    await c.say('lista pratiche');
    expect(c.last()).toContain('Fai parte di più organizzazioni');
    expect(c.last()).toContain(`1. ${tenantA.name} (amministratore)`);
    expect(c.last()).toContain(`2. ${tenantB.name} (collaboratore)`);

    await c.say('azienda 2');
    expect(c.last()).toContain(`Ora lavori per ${tenantB.name} come collaboratore`);
    await c.say('lista pratiche');
    expect(c.last()).toContain(`Pratica B ${run}`);
    expect(c.last()).not.toContain(`Pratica A ${run}`);
    await c.say('nuova scadenza durc 31/12/2027 DURC prova');
    expect(c.last()).toContain('operatore o un amministratore');

    await c.say('azienda 1');
    await c.say('nuova scadenza durc 31/12/2027 DURC prova');
    expect(c.last()).toContain('Scadenza registrata');
  });

  it('gives the HTTP API the role of the active membership in the token organization', async () => {
    const resolve = createPrismaPrincipalResolver(prisma);
    const ask = (tenantId: string) => resolve({ tenantId, userId, tokenRole: 'ADMIN' });
    expect((await ask(tenantA.id))?.role).toBe('ADMIN');
    expect((await ask(tenantB.id))?.role).toBe('MEMBER');

    await prisma.membership.update({
      where: { userId_orgId: { userId, orgId: tenantB.id } },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    expect(await ask(tenantB.id)).toBeNull();
    // A revoked membership is not reactivated by the old invite code.
    expect(await createTelegramIdentityProvider(prisma).link(inviteB, telegramId)).toBeNull();

    await prisma.tenant.update({ where: { id: tenantA.id }, data: { status: 'SUSPENDED' } });
    expect(await ask(tenantA.id)).toBeNull();
    await prisma.tenant.update({ where: { id: tenantA.id }, data: { status: 'ACTIVE' } });
    expect((await ask(tenantA.id))?.role).toBe('ADMIN');
  });

  it('sends notifications only to active people through active links', async () => {
    expect(await chatRecipients(prisma, tenantA.id, 'TELEGRAM')).toEqual([telegramId]);
    await prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    expect(await chatRecipients(prisma, tenantA.id, 'TELEGRAM')).toEqual([]);
    expect(
      await createPrismaPrincipalResolver(prisma)({
        tenantId: tenantA.id,
        userId,
        tokenRole: 'ADMIN',
      }),
    ).toBeNull();
    const c = chat();
    await c.say('lista pratiche');
    expect(c.last()).toContain('non è ancora collegato');
    await prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });

    await prisma.channelIdentity.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    expect(await chatRecipients(prisma, tenantA.id, 'TELEGRAM')).toEqual([]);
  });

  it('refuses in the database a practice of someone who is not a member', async () => {
    const outsider = await new UserRepository(prisma).createUser(tenantB.id, {
      email: `esterno-${run}@test.local`,
      role: 'MEMBER',
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO practice (id, tenant_id, user_id, status, version, payload, created_at, updated_at)
         VALUES (gen_random_uuid(), '${tenantA.id}', '${outsider.id}', 'CREATED', 1, '{}', now(), now())`,
      ),
    ).rejects.toThrow(/does not belong to tenant/);
  });
});
