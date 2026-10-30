/**
 * CURRENT BEHAVIOUR, NOT NORMATIVE.
 *
 * Characterization of who can do what today, per role, on the HTTP API, on chat and through the
 * AI. Written before MF2 (central authorization service) to prove the refactoring changes nothing
 * except the approved change C1 (role read from the database). Several cases describe behaviour
 * that is still to be decided (chat view C2, chat deletion C3, see
 * docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §3.4-§3.5): they must not be read as the future rule.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import {
  validateBeforeDecision,
  validateResolvedCommand,
} from '../src/ai/validation/pre-execution.validator.js';
import { loadConfig } from '../src/config/config.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { TelegramAdapter } from '../src/interface/telegram/telegram.adapter.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

type ListBody = { data: { items: Array<{ id: string }> } };

type Seed = {
  tenantId: string;
  otherTenantId: string;
  users: Record<'admin' | 'operator' | 'member' | 'member2' | 'otherAdmin', string>;
  practices: Record<'admin' | 'operator' | 'member' | 'member2' | 'other', string>;
  names: Record<'admin' | 'operator' | 'member' | 'member2' | 'other', string>;
};

describeWithDb('authorization: current behaviour (characterization, not normative)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let practiceService: PracticeApplicationService;
  let complianceService: ComplianceService;
  let seed: Seed;
  // The AI interpreter answers with whatever the test puts here.
  let llmAnswer = '';
  const llm: LLMClient = { mode: 'real', complete: () => Promise.resolve(llmAnswer) };
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    practiceService = new PracticeApplicationService(prisma);
    complianceService = new ComplianceService(prisma);

    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    const tenant = await tenants.createTenant({ name: `authz-char-${run}` });
    const other = await tenants.createTenant({ name: `authz-char-other-${run}` });
    const mk = (tenantId: string, key: string, role: UserRole) =>
      users.createUser(tenantId, { email: `${key}-${run}@authz.local`, role });
    const admin = await mk(tenant.id, 'admin', 'ADMIN');
    const operator = await mk(tenant.id, 'operator', 'OPERATOR');
    const member = await mk(tenant.id, 'member', 'MEMBER');
    const member2 = await mk(tenant.id, 'member2', 'MEMBER');
    const otherAdmin = await mk(other.id, 'other-admin', 'ADMIN');

    const names = {
      admin: `Pratica admin ${run}`,
      operator: `Pratica operator ${run}`,
      member: `Pratica member ${run}`,
      member2: `Pratica member2 ${run}`,
      other: `Pratica other ${run}`,
    };
    const create = async (tenantId: string, userId: string, name: string) =>
      (await practiceService.createPractice({ tenantId, userId, name, kind: 'music' })).id;
    seed = {
      tenantId: tenant.id,
      otherTenantId: other.id,
      users: {
        admin: admin.id,
        operator: operator.id,
        member: member.id,
        member2: member2.id,
        otherAdmin: otherAdmin.id,
      },
      practices: {
        admin: await create(tenant.id, admin.id, names.admin),
        operator: await create(tenant.id, operator.id, names.operator),
        member: await create(tenant.id, member.id, names.member),
        member2: await create(tenant.id, member2.id, names.member2),
        other: await create(other.id, otherAdmin.id, names.other),
      },
      names,
    };

    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3003',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-authz-characterization',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    app = buildServer(config, createLogger(config), {
      principals: testPrincipals(prisma),
      practiceService,
      complianceService,
      interpreterService: new InterpreterService(llm),
      executorService: new ExecutorService({ practiceService }),
      contextService: new ContextService(practiceService),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const as = (key: 'admin' | 'operator' | 'member') =>
    authHeaders(seed.tenantId, seed.users[key], key.toUpperCase() as UserRole);

  describe('HTTP API', () => {
    it('lists the whole tenant for ADMIN and OPERATOR, only own practices for MEMBER', async () => {
      for (const key of ['admin', 'operator'] as const) {
        const res = await app.inject({
          method: 'GET',
          url: '/practices?limit=100',
          headers: as(key),
        });
        expect(res.statusCode).toBe(200);
        const ids = res.json<ListBody>().data.items.map((p) => p.id);
        expect(ids).toEqual(
          expect.arrayContaining([
            seed.practices.admin,
            seed.practices.operator,
            seed.practices.member,
            seed.practices.member2,
          ]),
        );
        expect(ids).not.toContain(seed.practices.other);
      }
      const member = await app.inject({
        method: 'GET',
        url: `/practices?limit=100&userId=${seed.users.admin}`,
        headers: as('member'),
      });
      expect(member.json<ListBody>().data.items.map((p) => p.id)).toEqual([seed.practices.member]);
    });

    it('lets MEMBER read only own practices and attachments; nobody reads another tenant', async () => {
      const own = await app.inject({
        method: 'GET',
        url: `/practices/${seed.practices.member}`,
        headers: as('member'),
      });
      expect(own.statusCode).toBe(200);
      const notOwn = await app.inject({
        method: 'GET',
        url: `/practices/${seed.practices.admin}`,
        headers: as('member'),
      });
      expect(notOwn.statusCode).toBe(404);
      const attachments = await app.inject({
        method: 'GET',
        url: `/practices/${seed.practices.admin}/attachments`,
        headers: as('member'),
      });
      expect(attachments.statusCode).toBe(404);
      const operatorReadsMember = await app.inject({
        method: 'GET',
        url: `/practices/${seed.practices.member}`,
        headers: as('operator'),
      });
      expect(operatorReadsMember.statusCode).toBe(200);
      for (const key of ['admin', 'operator', 'member'] as const) {
        const cross = await app.inject({
          method: 'GET',
          url: `/practices/${seed.practices.other}`,
          headers: as(key),
        });
        expect(cross.statusCode).toBe(404);
      }
    });

    it('exports the tenant for ADMIN and OPERATOR, only own practices for MEMBER', async () => {
      const count = async (key: 'admin' | 'operator' | 'member') =>
        (
          await app.inject({
            method: 'POST',
            url: '/practices/export',
            headers: as(key),
            payload: {},
          })
        ).json<{ data: { count: number } }>().data.count;
      expect(await count('admin')).toBeGreaterThanOrEqual(4);
      expect(await count('operator')).toBe(await count('admin'));
      expect(await count('member')).toBe(1);
    });

    it('allows transitions to ADMIN and OPERATOR only, inside the tenant', async () => {
      const transition = (key: 'admin' | 'operator' | 'member', practiceId: string) =>
        app.inject({
          method: 'POST',
          url: `/practices/${practiceId}/transition`,
          headers: as(key),
          payload: { nextState: 'VALIDATED' },
        });
      expect((await transition('member', seed.practices.member)).statusCode).toBe(403);
      expect((await transition('operator', seed.practices.member2)).statusCode).toBe(200);
      expect((await transition('admin', seed.practices.operator)).statusCode).toBe(200);
      expect((await transition('admin', seed.practices.other)).statusCode).toBe(404);
    });

    it('lets every role create practices; AI traces are for ADMIN and OPERATOR', async () => {
      for (const key of ['admin', 'operator', 'member'] as const) {
        const created = await app.inject({
          method: 'POST',
          url: '/practices',
          headers: as(key),
          payload: { name: `Creata da ${key} ${run}`, kind: 'music' },
        });
        expect(created.statusCode).toBe(201);
      }
      expect(
        (await app.inject({ method: 'GET', url: '/ai/traces', headers: as('member') })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url: '/ai/traces', headers: as('operator') }))
          .statusCode,
      ).toBe(200);
    });

    it('scopes deadlines: MEMBER reads own only and cannot create or close', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/compliance/deadlines',
        headers: as('operator'),
        payload: {
          category: 'DURC',
          title: `DURC admin ${run}`,
          dueDate: '2027-12-31',
          userId: seed.users.admin,
        },
      });
      expect(created.statusCode).toBe(201);
      const memberCreate = await app.inject({
        method: 'POST',
        url: '/compliance/deadlines',
        headers: as('member'),
        payload: { category: 'DURC', title: 'x', dueDate: '2027-12-31' },
      });
      expect(memberCreate.statusCode).toBe(403);
      const memberList = await app.inject({
        method: 'GET',
        url: '/compliance/deadlines',
        headers: as('member'),
      });
      expect(memberList.statusCode).toBe(200);
      expect(
        memberList.json<{ data: Array<{ title: string }> }>().data.map((d) => d.title),
      ).not.toContain(`DURC admin ${run}`);
      const memberClose = await app.inject({
        method: 'POST',
        url: `/compliance/deadlines/${created.json<{ data: { id: string } }>().data.id}/close`,
        headers: as('member'),
      });
      expect(memberClose.statusCode).toBe(403);
    });

    it('blocks an AI transition requested by a MEMBER and allows it for an OPERATOR', async () => {
      const practiceId = seed.practices.member;
      llmAnswer = JSON.stringify({
        schemaVersion: 1,
        action: 'transition_practice',
        confidence: 0.99,
        filters: { practiceId, status: null, name: null },
        artistName: null,
        nextState: 'SUBMITTED',
        clarification: null,
      });
      const member = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: as('member'),
        payload: { input: `invia la pratica ${practiceId}` },
      });
      expect(member.statusCode).toBe(403);
    });
  });

  describe('chat (Telegram and WhatsApp share this logic)', () => {
    function chat(key: 'admin' | 'operator' | 'member', role: UserRole) {
      const replies: string[] = [];
      const service = new ConversationService(
        {
          practiceService,
          complianceService,
          handleMessage: () => Promise.resolve('ai'),
        },
        {
          name: 'telegram',
          identity: {
            link: () => Promise.resolve(null),
            resolve: () =>
              Promise.resolve({
                tenant: { id: seed.tenantId } as never,
                userId: seed.users[key],
                role,
              }),
          },
        },
      );
      return {
        replies,
        say: (text: string) =>
          service.handle({ senderId: `tg-${key}`, text }, (t) => {
            replies.push(t);
            return Promise.resolve();
          }),
      };
    }

    it('shows only own practices to every role, ADMIN and OPERATOR included (C2 pending)', async () => {
      for (const [key, role] of [
        ['admin', 'ADMIN'],
        ['operator', 'OPERATOR'],
        ['member', 'MEMBER'],
      ] as const) {
        const c = chat(key, role);
        await c.say('lista pratiche');
        expect(c.replies[0]).toContain(seed.names[key]);
        for (const otherKey of ['admin', 'operator', 'member', 'member2'] as const) {
          if (otherKey !== key) expect(c.replies[0]).not.toContain(seed.names[otherKey]);
        }
      }
    });

    it('finds the status and exports only among own practices', async () => {
      const admin = chat('admin', 'ADMIN');
      await admin.say(`stato pratica ${seed.names.member}`);
      // C2 (MF2b): still own practices only, with the hint to the explicit organization request.
      expect(admin.replies[0]).toContain('Nessuna delle tue pratiche');
      expect(admin.replies[0]).toContain('stato pratica azienda');
      await admin.say('export pratiche');
      expect(admin.replies[1]).toContain(seed.names.admin);
      expect(admin.replies[1]).not.toContain(seed.names.member);
    });

    it('lets any role delete its own practices immediately, without confirmation (C3 pending)', async () => {
      const member = chat('member', 'MEMBER');
      const name = `Da eliminare ${run}`;
      await practiceService.createPractice({
        tenantId: seed.tenantId,
        userId: seed.users.member,
        name,
        kind: 'music',
      });
      await member.say(`elimina pratica ${seed.names.admin}`);
      expect(member.replies[0]).toContain('Nessuna pratica trovata');
      await member.say(`elimina pratica ${name}`);
      expect(member.replies[1]).toContain(`Pratica eliminata: ${name}`);
    });

    it('lets MEMBER list own deadlines but not create them', async () => {
      const member = chat('member', 'MEMBER');
      await member.say('scadenze');
      expect(member.replies[0]).not.toContain(`DURC admin ${run}`);
      await member.say(`nuova scadenza durc 31/12/2027 DURC member ${run}`);
      expect(member.replies[1]).toContain('operatore o un amministratore');
      const operator = chat('operator', 'OPERATOR');
      await operator.say(`nuova scadenza durc 31/12/2027 DURC operator ${run}`);
      expect(operator.replies[0]).toContain('Scadenza registrata');
    });
  });

  describe('AI in chat', () => {
    function adapter() {
      return new TelegramAdapter({
        interpreter: new InterpreterService(llm),
        normalizer: new NormalizerService(),
        decisionEngine: new DecisionEngine(),
        validateBeforeDecision,
        validateResolvedCommand,
        executor: new ExecutorService({ practiceService }),
        contextService: new ContextService(practiceService),
        formatResponse: ({ result }) => (result.success ? 'ok' : 'failed'),
      });
    }

    it('refuses an AI transition to a MEMBER and executes it for an OPERATOR on own practices', async () => {
      const operatorPractice = await practiceService.createPractice({
        tenantId: seed.tenantId,
        userId: seed.users.operator,
        name: `Pratica AI ${run}`,
        kind: 'music',
      });
      llmAnswer = JSON.stringify({
        schemaVersion: 1,
        action: 'transition_practice',
        confidence: 0.99,
        filters: { practiceId: operatorPractice.id, status: null, name: null },
        artistName: null,
        nextState: 'VALIDATED',
        clarification: null,
      });
      await expect(
        adapter().handleMessage(`valida ${operatorPractice.id}`, {
          tenantId: seed.tenantId,
          userId: seed.users.member,
          role: 'MEMBER',
        }),
      ).rejects.toThrow('PERMISSION_DENIED:VALIDATED');
      await expect(
        adapter().handleMessage(`valida ${operatorPractice.id}`, {
          tenantId: seed.tenantId,
          userId: seed.users.operator,
          role: 'OPERATOR',
        }),
      ).resolves.toBe('ok');
    });
  });
});
