/**
 * Cantiere 3 (item 43): the card of one member, for the administrators: practices, assigned
 * practices, deadlines and documents of that person in the caller's organization only.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('member card (Cantiere 3)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId = '';
  let admin = '';
  let member = '';
  let operator = '';
  let otherOrg = '';
  let otherAdmin = '';

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    orgId = (await tenants.createTenant({ name: `c3-${run}` })).id;
    otherOrg = (await tenants.createTenant({ name: `c3-altra-${run}` })).id;
    admin = (await users.createUser(orgId, { email: `admin-${run}@c3.local`, role: 'ADMIN' })).id;
    member = (await users.createUser(orgId, { email: `socio-${run}@c3.local`, role: 'MEMBER' })).id;
    operator = (await users.createUser(orgId, { email: `op-${run}@c3.local`, role: 'OPERATOR' }))
      .id;
    otherAdmin = (
      await users.createUser(otherOrg, { email: `altro-${run}@c3.local`, role: 'ADMIN' })
    ).id;

    const practices = new PracticeApplicationService(prisma);
    const own = await practices.createPractice({
      tenantId: orgId,
      userId: member,
      name: `Domanda ${run}`,
    });
    await practices.createPractice({ tenantId: orgId, userId: member, name: `Seconda ${run}` });
    // A practice of the admin, followed by the operator.
    const followed = await practices.createPractice({
      tenantId: orgId,
      userId: admin,
      name: `Seguita ${run}`,
    });
    await prisma.practice.update({ where: { id: followed.id }, data: { assignedTo: operator } });
    await prisma.practiceAttachment.create({
      data: {
        tenantId: orgId,
        practiceId: own.id,
        fileName: 'fattura.pdf',
        mimeType: 'application/pdf',
        fileSize: 10,
        storagePath: `${orgId}/c3-${run}.pdf`,
        ocrStatus: 'COMPLETED',
      },
    });
    await new ComplianceService(prisma).createDeadline({
      tenantId: orgId,
      createdBy: admin,
      userId: member,
      category: 'ALTRO',
      title: `Visita ${run}`,
      dueDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3022',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-c3',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
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

  const get = (url: string, headers: object) =>
    app.inject({ method: 'GET', url, headers: headers as Record<string, string> });

  it('shows practices, deadlines and documents of the member', async () => {
    const res = await get(`/members/${member}`, authHeaders(orgId, admin, 'ADMIN'));
    expect(res.statusCode).toBe(200);
    const card = res.json<{
      data: {
        email: string;
        role: string;
        practices: { total: number; open: number; items: Array<{ name: string }> };
        deadlines: Array<{ title: string; daysLeft: number }>;
        documents: { total: number; toReview: number; items: Array<{ fileName: string }> };
      };
    }>().data;
    expect(card).toMatchObject({
      email: `socio-${run}@c3.local`,
      role: 'MEMBER',
      practices: { total: 2, open: 2 },
      documents: { total: 1, toReview: 1, items: [{ fileName: 'fattura.pdf' }] },
      deadlines: [{ title: `Visita ${run}`, daysLeft: 10 }],
    });
    expect(card.practices.items.map((p) => p.name).sort()).toEqual(
      [`Domanda ${run}`, `Seconda ${run}`].sort(),
    );
  });

  it('lists the practices a member follows', async () => {
    const res = await get(`/members/${operator}`, authHeaders(orgId, admin, 'ADMIN'));
    const card = res.json<{
      data: { practices: { total: number }; assigned: Array<{ name: string }> };
    }>().data;
    expect(card.practices.total).toBe(0);
    expect(card.assigned.map((p) => p.name)).toEqual([`Seguita ${run}`]);
  });

  it('is for administrators of the same organization only', async () => {
    expect((await get(`/members/${member}`, authHeaders(orgId, member, 'MEMBER'))).statusCode).toBe(
      403,
    );
    expect(
      (await get(`/members/${member}`, authHeaders(otherOrg, otherAdmin, 'ADMIN'))).statusCode,
    ).toBe(404);
    expect(
      (await get(`/members/${randomUUID()}`, authHeaders(orgId, admin, 'ADMIN'))).statusCode,
    ).toBe(404);
  });
});
