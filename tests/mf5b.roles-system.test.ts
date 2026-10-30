/**
 * Completion of MF5: an ADMIN changes the role of a member (never the last ADMIN), effective at
 * the next request; scheduled tasks run with a system identity limited to the organization, not
 * on behalf of "the first ADMIN". docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §5.
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
import { SchedulerService } from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { SystemActor } from '../src/core/authz/authorization.service.js';
import type { SchedulerTaskContext } from '../src/core/scheduler/scheduler.tasks.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('MF5 completion: roles and system identity', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId: string;
  let otherOrg: string;
  const users = { admin: '', operator: '', member: '', outsider: '' };

  const setRole = (userId: string, role: UserRole, by = users.admin, byRole: UserRole = 'ADMIN') =>
    app.inject({
      method: 'POST',
      url: `/members/${userId}/role`,
      headers: authHeaders(orgId, by, byRole),
      payload: { role },
    });
  const members = (userId: string, role: UserRole) =>
    app.inject({ method: 'GET', url: '/members', headers: authHeaders(orgId, userId, role) });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `mf5b-${run}` })).id;
    otherOrg = (await tenants.createTenant({ name: `mf5b-other-${run}` })).id;
    const repo = new UserRepository(prisma);
    const create = async (org: string, name: string, role: UserRole) =>
      (await repo.createUser(org, { email: `${name}-${run}@mf5b.local`, role })).id;
    users.admin = await create(orgId, 'admin', 'ADMIN');
    users.operator = await create(orgId, 'operator', 'OPERATOR');
    users.member = await create(orgId, 'member', 'MEMBER');
    users.outsider = await create(otherOrg, 'outsider', 'MEMBER');

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3008',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-mf5b',
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

  it('promotes and demotes a member, effective at the next request and audited', async () => {
    // The token still says OPERATOR: the role comes from the membership at every request.
    expect((await members(users.operator, 'OPERATOR')).statusCode).toBe(403);
    expect((await setRole(users.operator, 'ADMIN')).statusCode).toBe(200);
    expect((await members(users.operator, 'OPERATOR')).statusCode).toBe(200);

    expect((await setRole(users.operator, 'OPERATOR')).statusCode).toBe(200);
    expect((await members(users.operator, 'ADMIN')).statusCode).toBe(403);

    const changes = await prisma.auditLog.findMany({
      where: { tenantId: orgId, eventType: 'MEMBER_ROLE_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(changes.map((c) => c.payload)).toEqual([
      { targetUserId: users.operator, from: 'OPERATOR', to: 'ADMIN' },
      { targetUserId: users.operator, from: 'ADMIN', to: 'OPERATOR' },
    ]);
    // The legacy column stays equal in the person's legacy organization (until M3).
    const user = await prisma.user.findUniqueOrThrow({ where: { id: users.operator } });
    expect(user.role).toBe('OPERATOR');
    // Same role: nothing changes, nothing is audited.
    const same = await setRole(users.operator, 'OPERATOR');
    expect(same.json<{ data: { changed: boolean } }>().data.changed).toBe(false);
  });

  it('never removes the last active ADMIN', async () => {
    const res = await setRole(users.admin, 'OPERATOR');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('LAST_ADMIN');
    // With a second ADMIN the first one may step down.
    await setRole(users.member, 'ADMIN');
    expect((await setRole(users.admin, 'OPERATOR', users.member)).statusCode).toBe(200);
    expect((await setRole(users.admin, 'ADMIN', users.member)).statusCode).toBe(200);
    await setRole(users.member, 'MEMBER');
  });

  it('starts a new role clean: extra permissions and scheduled export are withdrawn', async () => {
    await prisma.membership.update({
      where: { userId_orgId: { userId: users.operator, orgId } },
      data: { extraPermissions: ['practice.export:tenant'] },
    });
    await setRole(users.operator, 'ADMIN');
    await prisma.membership.update({
      where: { userId_orgId: { userId: users.operator, orgId } },
      data: { scheduledExportSince: new Date() },
    });
    await setRole(users.operator, 'OPERATOR');
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_orgId: { userId: users.operator, orgId } },
    });
    expect(m.extraPermissions).toEqual([]);
    expect(m.scheduledExportSince).toBeNull();
  });

  it('is refused to non-admins and for people of other organizations', async () => {
    expect((await setRole(users.member, 'ADMIN', users.operator, 'OPERATOR')).statusCode).toBe(403);
    expect((await setRole(users.outsider, 'ADMIN')).statusCode).toBe(404);
  });

  it('runs scheduled tasks with the system identity of the organization', async () => {
    // An organization with no member at all: tasks no longer depend on "the first ADMIN".
    const empty = (await new TenantRepository(prisma).createTenant({ name: `mf5b-empty-${run}` }))
      .id;
    const seen: SystemActor[] = [];
    const scheduler = new SchedulerService(prisma, new PracticeApplicationService(prisma), {
      handlers: [
        {
          type: 'CHECK_COMPLIANCE_DEADLINES',
          run: (ctx: SchedulerTaskContext) => {
            seen.push(ctx.actor);
            return Promise.resolve({ ok: true });
          },
        },
      ],
    });
    const result = await scheduler.tick(new Date(), empty);
    expect(result.triggeredCount).toBe(1);
    expect(seen).toEqual([{ kind: 'system', orgId: empty, task: 'CHECK_COMPLIANCE_DEADLINES' }]);
  });
});
