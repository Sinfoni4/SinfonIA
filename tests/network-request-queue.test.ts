/**
 * The network's queue of requested documents: the open requests of every company whose practices
 * the caller can read through a delegation, nearest date first; never those of a company whose
 * delegation the caller cannot use; every use audited for the company.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { createDocumentRequest } from '../src/core/practice/document-request.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60_000;

type Queue = {
  requests: Array<{
    orgName: string;
    practiceName: string | null;
    message: string;
    dueDate: string | null;
    askedByUs: boolean;
    grantId: string;
  }>;
  organizations: number;
};

describe.runIf(Boolean(DATABASE_URL))('the network queue of requested documents', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org = { north: '', south: '', other: '', network: '' };
  const people: Record<string, string> = {};
  const grants: Record<string, string> = {};

  const as = (o: keyof typeof org, who: string, role: UserRole) =>
    authHeaders(org[o], people[who], role);
  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const queue = async (headers: Record<string, string>) => {
    const res = await call('GET', '/grants/document-requests', headers);
    expect(res.statusCode).toBe(200);
    return res.json<{ data: Queue }>().data;
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    for (const o of ['north', 'south', 'other'] as const) {
      org[o] = (await tenants.createTenant({ name: `Azienda ${o} ${run}`, module: 'agri' })).id;
    }
    org.network = (await tenants.createTenant({ name: `Rete ${run}` })).id;
    await prisma.tenant.update({ where: { id: org.network }, data: { type: 'NETWORK' } });
    const add = async (o: keyof typeof org, who: string, role: UserRole) => {
      people[who] = (
        await users.createUser(org[o], { email: `${who}-${run}@queue.local`, role })
      ).id;
    };
    await add('north', 'northAdmin', 'ADMIN');
    await add('south', 'southAdmin', 'ADMIN');
    await add('other', 'otherAdmin', 'ADMIN');
    await add('network', 'netAdmin', 'ADMIN');
    await add('network', 'netOperator', 'OPERATOR');

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3018',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-queue',
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

    const validUntil = new Date(Date.now() + 90 * DAY_MS).toISOString().slice(0, 10);
    // North and South give a delegation to the network; only North approves the operator.
    for (const [o, admin] of [
      ['north', 'northAdmin'],
      ['south', 'southAdmin'],
    ] as const) {
      const issued = await call('POST', '/grants', as(o, admin, 'ADMIN'), {
        grantee: { orgId: org.network },
        operations: ['READ', 'UPDATE'],
        validUntil,
      });
      grants[o] = issued.json<{ data: { id: string } }>().data.id;
      await call('POST', `/grants/${grants[o]}/beneficiaries`, as('network', 'netAdmin', 'ADMIN'), {
        userId: people.netOperator,
      });
    }
    await call(
      'POST',
      `/grants/${grants.north}/beneficiaries/approve`,
      as('north', 'northAdmin', 'ADMIN'),
      {
        userId: people.netOperator,
      },
    );

    const ask = async (
      o: keyof typeof org,
      admin: string,
      dueDate: string | null,
      message: string,
      requesterOrgId = org[o],
    ) => {
      const practiceId = (
        await practices.createPractice({
          tenantId: org[o],
          userId: people[admin],
          name: `${message} ${run}`,
        })
      ).id;
      await createDocumentRequest(prisma, {
        tenantId: org[o],
        practiceId,
        message,
        dueDate,
        actorUserId: people[admin],
        requesterOrgId,
        channel: 'dashboard',
      });
    };
    await ask('north', 'northAdmin', '2027-03-10', 'Visura camerale');
    await ask('north', 'northAdmin', null, 'Foto del trattore');
    await ask('north', 'northAdmin', '2027-01-05', 'Certificato bio', org.network);
    await ask('south', 'southAdmin', '2027-01-01', 'Contratto di affitto');
    await ask('other', 'otherAdmin', '2027-01-01', 'Mappa dei campi');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('lists the requests of the companies whose delegation one can use, nearest date first', async () => {
    const data = await queue(as('network', 'netOperator', 'OPERATOR'));
    expect(data.organizations).toBe(1);
    expect(data.requests.map((r) => [r.message, r.dueDate, r.askedByUs])).toEqual([
      ['Certificato bio', '2027-01-05', true],
      ['Visura camerale', '2027-03-10', false],
      ['Foto del trattore', null, false],
    ]);
    expect(new Set(data.requests.map((r) => r.orgName))).toEqual(new Set([`Azienda north ${run}`]));
    expect(data.requests[0].grantId).toBe(grants.north);
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: org.north, eventType: 'DELEGATED_ACCESS', userId: people.netOperator },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.payload).toEqual({ grantId: grants.north, action: 'requests' });
    // South did not approve the operator: none of its requests, nor any audit there.
    expect(
      await prisma.auditLog.count({
        where: { tenantId: org.south, eventType: 'DELEGATED_ACCESS', userId: people.netOperator },
      }),
    ).toBe(0);
  });

  it('shows nothing to whoever is not a beneficiary, nor once the delegation is revoked', async () => {
    expect(await queue(as('network', 'netAdmin', 'ADMIN'))).toEqual({
      requests: [],
      organizations: 0,
    });
    await call('POST', `/grants/${grants.north}/revoke`, as('north', 'northAdmin', 'ADMIN'), {});
    expect(await queue(as('network', 'netOperator', 'OPERATOR'))).toEqual({
      requests: [],
      organizations: 0,
    });
  });
});
