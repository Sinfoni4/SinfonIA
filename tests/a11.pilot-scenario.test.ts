/**
 * A11 (docs/FASE1_CORE_E_MODULI.md §6): B5 checked on the scenario of the TerreFVG pilot, with the
 * modules and the functions of phase 1 together — an agricultural network with its companies, a
 * consultant working for one company through a delegation, and the platform turning functions off.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (offset: number) =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

describe.runIf(Boolean(DATABASE_URL))(
  'pilot scenario: network, companies, consultant (A11)',
  () => {
    const run = randomUUID().slice(0, 8);
    let prisma: PrismaClient;
    let app: ReturnType<typeof buildServer>;
    let networkId = '';
    let networkOperator = '';
    let networkAdmin = '';
    let studioId = '';
    let consultant = '';
    const consultantEmail = `consulente-${run}@a11.local`;
    const companies: Array<{ id: string; admin: string }> = [];
    let practiceId = '';
    let grantId = '';

    const call = (method: 'GET' | 'POST', url: string, headers: object, payload?: object) =>
      app.inject({
        method,
        url,
        headers: headers as Record<string, string>,
        ...(payload ? { payload } : {}),
      });
    const company = (i: number) => authHeaders(companies[i].id, companies[i].admin, 'ADMIN');
    const net = () => authHeaders(networkId, networkAdmin, 'ADMIN');
    const netOperator = () => authHeaders(networkId, networkOperator, 'OPERATOR');
    const studio = () => authHeaders(studioId, consultant, 'ADMIN');
    const turnOff = (orgId: string, features: string[]) =>
      prisma.tenant.update({ where: { id: orgId }, data: { disabledFeatures: features } });

    beforeAll(async () => {
      prisma = createPrismaClient(DATABASE_URL!);
      await prisma.$connect();
      const tenants = new TenantRepository(prisma);
      const users = new UserRepository(prisma);
      networkId = (await tenants.createTenant({ name: `Rete agricola ${run}`, module: 'agri' })).id;
      await prisma.tenant.update({ where: { id: networkId }, data: { type: 'NETWORK' } });
      networkAdmin = (
        await users.createUser(networkId, { email: `rete-${run}@a11.local`, role: 'ADMIN' })
      ).id;
      networkOperator = (
        await users.createUser(networkId, { email: `rete-op-${run}@a11.local`, role: 'OPERATOR' })
      ).id;
      studioId = (await tenants.createTenant({ name: `Studio agronomico ${run}` })).id;
      consultant = (await users.createUser(studioId, { email: consultantEmail, role: 'ADMIN' })).id;
      for (let i = 0; i < 5; i++) {
        const id = (await tenants.createTenant({ name: `Azienda ${i} ${run}`, module: 'agri' })).id;
        const admin = (
          await users.createUser(id, { email: `azienda${i}-${run}@a11.local`, role: 'ADMIN' })
        ).id;
        companies.push({ id, admin });
      }

      const cfg = loadConfig({
        NODE_ENV: 'test',
        PORT: '3019',
        DATABASE_URL: DATABASE_URL!,
        SERVICE_NAME: 'sinfonia-a11',
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

    it('builds the network: the companies confirm, the network sees none of their data', async () => {
      for (let i = 0; i < companies.length; i++) {
        const invited = await call('POST', '/network/members', net(), { orgId: companies[i].id });
        expect(invited.statusCode).toBe(201);
        const { relationId } = invited.json<{ data: { relationId: string } }>().data;
        expect(
          (await call('POST', `/memberships/${relationId}/confirm`, company(i))).statusCode,
        ).toBe(200);
      }
      const created = await call('POST', '/practices', company(0), {
        name: `Domanda PAC ${run}`,
        kind: 'agri',
        fields: { procedure: 'pac', campaignYear: 2027 },
      });
      expect(created.statusCode).toBe(201);
      practiceId = created.json<{ data: { id: string } }>().data.id;
      const read = await call('GET', `/practices/${practiceId}`, company(0));
      expect(read.json<{ data: { fields: object } }>().data.fields).toEqual({
        procedure: 'pac',
        campaignYear: 2027,
      });
      // Membership gives the network nothing on the data of the company.
      expect((await call('GET', `/practices/${practiceId}`, net())).statusCode).toBe(404);
      const stats = await call('GET', '/network/stats?period=month', netOperator());
      expect(stats.statusCode).toBe(200);
      expect(stats.body).not.toContain(`Domanda PAC ${run}`);
    });

    it('lets the consultant read the agricultural practice through the delegation only', async () => {
      const res = await call('POST', '/grants', company(0), {
        grantee: { email: consultantEmail },
        operations: ['READ'],
        validUntil: isoDay(90),
      });
      expect(res.statusCode).toBe(201);
      grantId = res.json<{ data: { id: string } }>().data.id;
      const list = await call('GET', `/grants/${grantId}/practices`, studio());
      expect(list.statusCode).toBe(200);
      const items = list.json<{ data: { items: Array<{ id: string; kind: string }> } }>().data
        .items;
      expect(items.map((p) => [p.id, p.kind])).toEqual([[practiceId, 'agri']]);
      // Without the delegation, the practice of the company does not exist for the studio.
      expect((await call('GET', `/practices/${practiceId}`, studio())).statusCode).toBe(404);
      // Another company of the same network is not reachable through this delegation.
      expect(
        (await call('GET', `/grants/${grantId}/practices/${randomUUID()}`, studio())).statusCode,
      ).toBe(404);
    });

    it('stops the delegations when either side turns them off, and restores them after', async () => {
      // The company that gave it: the delegation gives nothing, as if it did not exist.
      await turnOff(companies[0].id, ['delegations']);
      expect((await call('GET', `/grants/${grantId}/practices`, studio())).statusCode).toBe(404);
      expect((await call('GET', '/grants/issued', company(0))).statusCode).toBe(403);
      await turnOff(companies[0].id, []);
      expect((await call('GET', `/grants/${grantId}/practices`, studio())).statusCode).toBe(200);

      // The organization that received it: refused, and it says why.
      await turnOff(studioId, ['delegations']);
      const refused = await call('GET', `/grants/${grantId}/practices`, studio());
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('FEATURE_DISABLED');
      await turnOff(studioId, []);
      expect((await call('GET', `/grants/${grantId}/practices`, studio())).statusCode).toBe(200);
    });

    it('turns the network statistics off and on without touching the memberships', async () => {
      await turnOff(networkId, ['network_stats']);
      const refused = await call('GET', '/network/stats?period=month', netOperator());
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('FEATURE_DISABLED');
      // The members list is not a statistic: still there.
      expect((await call('GET', '/network/members', net())).statusCode).toBe(200);
      await turnOff(networkId, []);
      expect((await call('GET', '/network/stats?period=month', netOperator())).statusCode).toBe(
        200,
      );
    });

    it('keeps every step in the logs of the organizations concerned', async () => {
      expect(
        await prisma.auditLog.count({
          where: { tenantId: companies[0].id, eventType: 'DELEGATED_ACCESS' },
        }),
      ).toBeGreaterThanOrEqual(3);
      expect(
        await prisma.auditLog.count({
          where: { tenantId: companies[0].id, eventType: 'PRACTICE_CREATED' },
        }),
      ).toBe(1);
    });
  },
);
