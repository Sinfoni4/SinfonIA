/**
 * MF8 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2.4, decision D3): delegations from a company to
 * a network (with named beneficiaries) or to a person (a consultant), checked at every request,
 * with the D3 durations and the reminders before the end.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import {
  checkDelegation,
  grantState,
  maxValidUntil,
} from '../src/core/delegation/delegation.service.js';
import {
  GRANT_EXPIRING,
  GrantExpiringHandler,
  GrantExpiryTask,
} from '../src/core/delegation/grant-reminders.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

describe('D3 durations', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS);

  it('allows 12 months, 3 with export, and needs reading', () => {
    expect(maxValidUntil(['READ'], now).toISOString().slice(0, 10)).toBe('2027-11-05');
    expect(maxValidUntil(['READ', 'EXPORT'], now).toISOString().slice(0, 10)).toBe('2027-02-05');
    expect(checkDelegation(['READ', 'UPDATE', 'READ'], at(300), now)).toEqual(['READ', 'UPDATE']);
    expect(() => checkDelegation(['READ'], at(400), now)).toThrow(/12 mesi/);
    // The dashboard sends the end of the chosen day: 12 months from today is allowed.
    expect(checkDelegation(['READ'], new Date('2027-11-05T23:59:59+01:00'), now)).toEqual(['READ']);
    expect(() => checkDelegation(['READ'], new Date('2027-11-07T00:00:00Z'), now)).toThrow(
      /12 mesi/,
    );
    expect(() => checkDelegation(['READ', 'EXPORT'], at(120), now)).toThrow(/3 mesi/);
    // Just after midnight in Italy (still the day before in UTC) 12 months from the Italian
    // today are allowed, as the dashboard proposes them.
    const night = new Date('2026-11-05T23:30:00Z'); // 00:30 of 6 November in Italy
    expect(checkDelegation(['READ'], new Date('2027-11-06T23:59:59+01:00'), night)).toEqual([
      'READ',
    ]);
    expect(() => checkDelegation(['READ'], new Date('2027-11-07T23:59:59+01:00'), night)).toThrow(
      /12 mesi/,
    );
    expect(() => checkDelegation(['UPDATE'], at(30), now)).toThrow(/lettura/);
    expect(() => checkDelegation(['READ', 'DELETE'], at(30), now)).toThrow(
      /non ancora disponibili/,
    );
    expect(() => checkDelegation(['READ'], at(0), now)).toThrow(/domani/);
  });

  it('shows a delegation past its end as expired', () => {
    expect(grantState({ status: 'ACTIVE', validUntil: at(-1) }, now)).toBe('EXPIRED');
    expect(grantState({ status: 'ACTIVE', validUntil: at(1) }, now)).toBe('ACTIVE');
    expect(grantState({ status: 'REVOKED', validUntil: at(1) }, now)).toBe('REVOKED');
  });
});

describe.runIf(Boolean(DATABASE_URL))('delegations with PostgreSQL (MF8)', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org: Record<'company' | 'network' | 'studio', string> = {
    company: '',
    network: '',
    studio: '',
  };
  const people: Record<string, string> = {};
  let practiceId = '';
  let networkGrant = '';
  const companyAdminChat = `93${digits}1`;
  const consultantEmail = `consulente-${run}@mf8.local`;

  const as = (o: keyof typeof org, who: string, role: UserRole) =>
    authHeaders(org[o], people[who], role);
  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const companyAdmin = () => as('company', 'companyAdmin', 'ADMIN');
  const netAdmin = () => as('network', 'netAdmin', 'ADMIN');
  const netOperator = () => as('network', 'netOperator', 'OPERATOR');
  const consultant = () => as('studio', 'consultant', 'ADMIN');
  const delegated = (grantId: string, headers: Record<string, string>) =>
    call('GET', `/grants/${grantId}/practices`, headers);

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.company = (await tenants.createTenant({ name: `Azienda delegante ${run}` })).id;
    org.network = (await tenants.createTenant({ name: `Rete delegata ${run}` })).id;
    org.studio = (await tenants.createTenant({ name: `Studio ${run}` })).id;
    await prisma.tenant.update({ where: { id: org.network }, data: { type: 'NETWORK' } });
    const add = async (o: keyof typeof org, who: string, role: UserRole, extra = {}) => {
      people[who] = (
        await users.createUser(org[o], { email: `${who}-${run}@mf8.local`, role, ...extra })
      ).id;
    };
    await add('company', 'companyAdmin', 'ADMIN', { telegramId: companyAdminChat });
    await add('network', 'netAdmin', 'ADMIN');
    await add('network', 'netOperator', 'OPERATOR');
    people.consultant = (
      await users.createUser(org.studio, { email: consultantEmail, role: 'ADMIN' })
    ).id;
    practiceId = (
      await prisma.practice.create({
        data: {
          tenantId: org.company,
          userId: people.companyAdmin,
          payload: { schemaVersion: 2, name: `Fascicolo aziendale ${run}` },
        },
      })
    ).id;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3014',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-mf8',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
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

  it('refuses durations and operations outside D3', async () => {
    const tooLong = await call('POST', '/grants', companyAdmin(), {
      grantee: { orgId: org.network },
      operations: ['READ'],
      validUntil: isoDay(400),
    });
    expect(tooLong.statusCode).toBe(400);
    const exportTooLong = await call('POST', '/grants', companyAdmin(), {
      grantee: { email: consultantEmail },
      operations: ['READ', 'EXPORT'],
      validUntil: isoDay(120),
    });
    expect(exportTooLong.statusCode).toBe(400);
    // Only an administrator gives delegations.
    const byOperator = await call('POST', '/grants', netOperator(), {
      grantee: { orgId: org.company },
      operations: ['READ'],
      validUntil: isoDay(30),
    });
    expect(byOperator.statusCode).toBe(403);
  });

  it('gives nothing to a network until the company approves a named person (§2.4)', async () => {
    const res = await call('POST', '/grants', companyAdmin(), {
      grantee: { orgId: org.network },
      operations: ['READ', 'UPDATE'],
      validUntil: isoDay(180),
    });
    expect(res.statusCode).toBe(201);
    networkGrant = res.json<{ data: { id: string } }>().data.id;
    const received = (await call('GET', '/grants/received', netAdmin())).json<{
      data: Array<{ id: string; usable: boolean; grantor: { name: string } }>;
    }>().data;
    expect(received.map((g) => [g.id, g.usable, g.grantor.name])).toEqual([
      [networkGrant, false, `Azienda delegante ${run}`],
    ]);
    // Members of the network, administrator included, get nothing yet.
    expect((await delegated(networkGrant, netAdmin())).statusCode).toBe(404);
    expect((await delegated(networkGrant, netOperator())).statusCode).toBe(404);

    // The network names its operator; only the company approves.
    const proposed = await call('POST', `/grants/${networkGrant}/beneficiaries`, netAdmin(), {
      userId: people.netOperator,
    });
    expect(proposed.statusCode).toBe(201);
    expect((await delegated(networkGrant, netOperator())).statusCode).toBe(404);
    expect(
      (
        await call('POST', `/grants/${networkGrant}/beneficiaries/approve`, netAdmin(), {
          userId: people.netOperator,
        })
      ).statusCode,
    ).toBe(404);
    const approved = await call(
      'POST',
      `/grants/${networkGrant}/beneficiaries/approve`,
      companyAdmin(),
      { userId: people.netOperator },
    );
    expect(approved.statusCode).toBe(200);

    const list = await delegated(networkGrant, netOperator());
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ data: { items: Array<{ id: string }> } }>().data.items.map((p) => p.id),
    ).toEqual([practiceId]);
    // The administrator of the network, not approved, still gets nothing.
    expect((await delegated(networkGrant, netAdmin())).statusCode).toBe(404);
    // Every use is in the log of the company.
    expect(
      await prisma.auditLog.count({
        where: { tenantId: org.company, eventType: 'DELEGATED_ACCESS' },
      }),
    ).toBe(1);
  });

  it('allows only the delegated operations', async () => {
    const moved = await call(
      'POST',
      `/grants/${networkGrant}/practices/${practiceId}/transition`,
      netOperator(),
      { nextState: 'VALIDATED' },
    );
    expect(moved.statusCode).toBe(200);
    const exported = await call('POST', `/grants/${networkGrant}/export`, netOperator(), {});
    expect(exported.statusCode).toBe(403);
    expect(exported.json<{ error: { code: string } }>().error.code).toBe('OPERATION_NOT_DELEGATED');
  });

  it('ends access when the beneficiary is removed or the delegation revoked', async () => {
    await call('POST', `/grants/${networkGrant}/beneficiaries/remove`, companyAdmin(), {
      userId: people.netOperator,
    });
    expect((await delegated(networkGrant, netOperator())).statusCode).toBe(404);
    expect(
      (
        await call('POST', `/grants/${networkGrant}/revoke`, companyAdmin(), {
          reason: 'Fine collaborazione',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('POST', `/grants/${networkGrant}/renew`, companyAdmin(), {
          validUntil: isoDay(30),
        })
      ).statusCode,
    ).toBe(409);
    const issued = (await call('GET', '/grants/issued', companyAdmin())).json<{
      data: Array<{ id: string; state: string }>;
    }>().data;
    expect(issued.find((g) => g.id === networkGrant)?.state).toBe('REVOKED');
  });

  it('lets a consultant work for the company from their own organization, until the end date', async () => {
    const res = await call('POST', '/grants', companyAdmin(), {
      grantee: { email: consultantEmail.toUpperCase() },
      operations: ['READ', 'EXPORT'],
      validUntil: isoDay(60),
    });
    expect(res.statusCode).toBe(201);
    const grantId = res.json<{ data: { id: string } }>().data.id;
    expect((await delegated(grantId, consultant())).statusCode).toBe(200);
    const exported = await call('POST', `/grants/${grantId}/export`, consultant(), {});
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain(`Fascicolo aziendale ${run}`);
    // Past its end date the delegation gives nothing, and shows as expired.
    await prisma.accessGrant.update({
      where: { id: grantId },
      data: {
        validFrom: new Date(Date.now() - 2 * DAY_MS),
        validUntil: new Date(Date.now() - 1000),
      },
    });
    expect((await delegated(grantId, consultant())).statusCode).toBe(404);
    const issued = (await call('GET', '/grants/issued', companyAdmin())).json<{
      data: Array<{ id: string; state: string }>;
    }>().data;
    expect(issued.find((g) => g.id === grantId)?.state).toBe('EXPIRED');
    // An explicit renewal brings it back.
    expect(
      (await call('POST', `/grants/${grantId}/renew`, companyAdmin(), { validUntil: isoDay(30) }))
        .statusCode,
    ).toBe(200);
    expect((await delegated(grantId, consultant())).statusCode).toBe(200);
  });

  it('reminds the company 30 and 7 days before the end, once each', async () => {
    const res = await call('POST', '/grants', companyAdmin(), {
      grantee: { orgId: org.studio },
      operations: ['READ'],
      validUntil: isoDay(25),
    });
    const grantId = res.json<{ data: { id: string } }>().data.id;
    const task = new GrantExpiryTask(prisma);
    const tenant = { id: org.company } as Tenant;
    const runAt = (now: Date) => task.run({ tenant, now, payload: {} } as never);
    const count = () =>
      prisma.outboxMessage.count({
        where: {
          tenantId: org.company,
          eventType: GRANT_EXPIRING,
          payload: { path: ['grantId'], equals: grantId },
        },
      });
    await runAt(new Date());
    await runAt(new Date());
    expect(await count()).toBe(1);
    await runAt(new Date(Date.now() + 20 * DAY_MS));
    expect(await count()).toBe(2);

    const message = await prisma.outboxMessage.findFirstOrThrow({
      where: {
        tenantId: org.company,
        eventType: GRANT_EXPIRING,
        payload: { path: ['grantId'], equals: grantId },
      },
      orderBy: { createdAt: 'desc' },
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    const telegram: ChatNotifier = {
      sendDocument: () => Promise.resolve(),
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    };
    const deliveries = await new GrantExpiringHandler(prisma, { telegram }).resolveDeliveries(
      message as unknown as ClaimedOutboxMessage,
    );
    for (const d of deliveries) await d.send();
    expect(sent.map((s) => s.chatId)).toEqual([companyAdminChat]);
    expect(sent[0].text).toContain(`La delega a «Studio ${run}» scade il`);
  });
});
