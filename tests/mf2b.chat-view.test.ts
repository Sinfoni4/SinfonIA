/**
 * MF2b (decision C2, approved 29/10/2026): in chat everyone sees their own practices by default.
 * ADMIN and OPERATOR reach the organization only with explicit requests, paginated, and confirm a
 * transition of a practice that is not theirs. The permission is never widened.
 * docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §3.4.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_PRACTICES_PAGE_SIZE,
  PracticeApplicationService,
} from '../src/core/practice/practice.application.service.js';
import { parsePracticeCommand } from '../src/core/practice/practice.commands.js';
import { getTenantById } from '../src/core/tenant/tenant.store.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';

import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('chat commands on the organization (parsing)', () => {
  it('recognizes the explicit organization forms before the default ones', () => {
    expect(parsePracticeCommand('pratiche azienda')).toEqual({
      type: 'LIST_ORG_PRACTICES',
      payload: { page: 1 },
    });
    expect(parsePracticeCommand("lista pratiche dell'azienda 3")).toEqual({
      type: 'LIST_ORG_PRACTICES',
      payload: { page: 3 },
    });
    expect(parsePracticeCommand('stato pratica azienda Mario Rossi')).toEqual({
      type: 'GET_ORG_PRACTICE_STATUS',
      payload: { name: 'Mario Rossi' },
    });
    expect(parsePracticeCommand('valida pratica azienda Mario Rossi')).toEqual({
      type: 'TRANSITION_ORG_PRACTICE',
      payload: { name: 'Mario Rossi', nextState: 'VALIDATED' },
    });
    expect(parsePracticeCommand('completa pratica azienda Mario Rossi')).toEqual({
      type: 'TRANSITION_ORG_PRACTICE',
      payload: { name: 'Mario Rossi', nextState: 'COMPLETED' },
    });
    // The default forms are unchanged.
    expect(parsePracticeCommand('lista pratiche')?.type).toBe('LIST_PRACTICES');
    expect(parsePracticeCommand('stato pratica Mario Rossi')?.type).toBe('GET_PRACTICE_STATUS');
  });
});

describe.runIf(Boolean(DATABASE_URL))('chat default view and explicit requests (C2)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let tenantId: string;
  const users: Record<'admin' | 'operator' | 'member', string> = {
    admin: '',
    operator: '',
    member: '',
  };
  const name = (who: string) => `Pratica ${who} ${run}`;

  const chat = (who: keyof typeof users, role: UserRole) => {
    const replies: string[] = [];
    const service = new ConversationService(
      {
        practiceService: new PracticeApplicationService(prisma),
        handleMessage: () => Promise.resolve('ai'),
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
    return {
      say: async (text: string) => {
        await service.handle({ senderId: who, text }, (t) => {
          replies.push(t);
          return Promise.resolve();
        });
        return replies.at(-1) ?? '';
      },
    };
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (await new TenantRepository(prisma).createTenant({ name: `mf2b-${run}` })).id;
    const repo = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['operator', 'OPERATOR'],
      ['member', 'MEMBER'],
    ] as const) {
      users[who] = (
        await repo.createUser(tenantId, { email: `${who}-${run}@mf2b.local`, role })
      ).id;
    }
    const practices = new PracticeApplicationService(prisma);
    for (const who of ['admin', 'operator', 'member'] as const) {
      await practices.createPractice({
        tenantId,
        userId: users[who],
        name: name(who),
        kind: 'music',
      });
    }
    // Two practices with the same name: an explicit request never picks one at random.
    for (const who of ['admin', 'member'] as const) {
      await practices.createPractice({
        tenantId,
        userId: users[who],
        name: `Doppia ${run}`,
        kind: 'music',
      });
    }
    // Enough practices for a second page.
    for (let i = 0; i < ORG_PRACTICES_PAGE_SIZE; i++) {
      await practices.createPractice({
        tenantId,
        userId: users.member,
        name: `Extra ${i} ${run}`,
        kind: 'music',
      });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('shows only the caller own practices by default, for every role', async () => {
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['operator', 'OPERATOR'],
    ] as const) {
      const list = await chat(who, role).say('lista pratiche');
      expect(list).toContain(name(who));
      expect(list).not.toContain(name('member'));
    }
  });

  it('lists the organization on explicit request, paginated, marking own practices', async () => {
    const c = chat('operator', 'OPERATOR');
    const first = await c.say('pratiche azienda');
    expect(first).toContain('pagina 1 di 2');
    expect(first).toContain(`${ORG_PRACTICES_PAGE_SIZE + 5} in tutto`);
    expect(first).toContain('«pratiche azienda 2»');
    const second = await c.say('pratiche azienda 2');
    expect(second).toContain('pagina 2 di 2');
    const all = `${first}\n${second}`;
    expect(all).toContain(`${name('operator')}: CREATED (tua)`);
    expect(all).toContain(`${name('member')}: CREATED\n`);
  });

  it('never widens the view of a MEMBER', async () => {
    const c = chat('member', 'MEMBER');
    expect(await c.say('pratiche azienda')).toContain('solo le tue pratiche');
    expect(await c.say(`stato pratica azienda ${name('admin')}`)).toContain('solo le tue pratiche');
    const own = await c.say(`stato pratica ${name('admin')}`);
    expect(own).toContain('Nessuna pratica trovata');
    expect(own).not.toContain('stato pratica azienda');
    expect(await c.say(`valida pratica azienda ${name('member')}`)).toContain(
      'operatore o un amministratore',
    );
  });

  it('searches own practices first and the organization only when asked', async () => {
    const c = chat('admin', 'ADMIN');
    const own = await c.say(`stato pratica ${name('member')}`);
    expect(own).toContain('Nessuna delle tue pratiche');
    expect(own).toContain(`«stato pratica azienda ${name('member')}»`);
    expect(await c.say(`stato pratica azienda ${name('member')}`)).toBe(
      `🏢 Stato pratica ${name('member')}: CREATED`,
    );
    const twice = await c.say(`stato pratica azienda Doppia ${run}`);
    expect(twice).toContain('ci sono 2 pratiche');
  });

  it('asks for confirmation before changing a practice that is not the caller own', async () => {
    const c = chat('operator', 'OPERATOR');
    const status = () =>
      prisma.practice.findFirstOrThrow({
        where: {
          tenantId,
          userId: users.member,
          payload: { path: ['name'], equals: name('member') },
        },
        select: { status: true },
      });

    expect(await c.say(`valida pratica azienda ${name('member')}`)).toContain('non è tua');
    expect(await c.say('no')).toBe('Ok, operazione annullata.');
    expect((await status()).status).toBe('CREATED');

    await c.say(`valida pratica azienda ${name('member')}`);
    expect(await c.say('sì')).toBe(`✅ Pratica ${name('member')}: VALIDATED`);
    expect((await status()).status).toBe('VALIDATED');
    // A second «sì» confirms nothing.
    expect(await c.say('sì')).not.toContain('✅');

    // Own practice: no confirmation needed.
    expect(await chat('admin', 'ADMIN').say(`valida pratica azienda ${name('admin')}`)).toBe(
      `✅ Pratica ${name('admin')}: VALIDATED`,
    );
    // Same name twice: nothing is changed.
    expect(await c.say(`valida pratica azienda Doppia ${run}`)).toContain('Non ho fatto nulla');
  });

  it('re-checks the permission and the practice at confirmation time', async () => {
    const practices = new PracticeApplicationService(prisma);
    const target = await prisma.practice.findFirstOrThrow({
      where: { tenantId, userId: users.member },
      select: { id: true },
    });
    const confirm = {
      type: 'CONFIRM_TRANSITION',
      payload: { practiceId: target.id, nextState: 'VALIDATED' },
    } as const;
    // Demoted to MEMBER before answering: the transition is refused.
    await expect(
      practices.executeCommand(confirm, { tenantId, userId: users.operator, role: 'MEMBER' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    // Another organization never reaches the practice.
    const other = (await new TenantRepository(prisma).createTenant({ name: `mf2b-x-${run}` })).id;
    await expect(
      practices.executeCommand(confirm, { tenantId: other, userId: users.operator, role: 'ADMIN' }),
    ).rejects.toThrow(/not found/i);
  });
});
