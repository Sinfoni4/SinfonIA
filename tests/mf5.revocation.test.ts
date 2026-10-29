/**
 * MF5 (revocation): every change of access takes effect at the next request. Tokens carry the
 * person's auth_version and, from MF6, a session; members are revoked by their administrators;
 * suspended organizations get no scheduled task and no delivery; attachments are downloaded only
 * after the access check. docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §5.
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
import { revokeAllSessions, setUserStatus } from '../src/core/identity/revocation.service.js';
import { DeliveryError } from '../src/core/outbox/outbox.delivery.js';
import { chatDeliveries } from '../src/core/outbox/outbox.recipients.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { SchedulerService } from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { issueAuthToken } from '../src/interface/http/auth/token.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { TEST_AUTH_CONFIG, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('MF5 revocation', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgA: string;
  let orgB: string;
  let admin: string;
  let member: string;
  let colleague: string;
  let adminB: string;
  let practice: string;
  let attachment: string;

  const headers = (
    tenantId: string,
    userId: string,
    role: UserRole,
    extra: { authVersion?: number; sessionId?: string } = {},
  ) => ({
    authorization: `Bearer ${issueAuthToken({ tenantId, userId, role, ...extra }, TEST_AUTH_CONFIG)}`,
  });
  const get = (url: string, h: { authorization: string }) =>
    app.inject({ method: 'GET', url, headers: h });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    orgA = (await tenants.createTenant({ name: `mf5-a-${run}` })).id;
    orgB = (await tenants.createTenant({ name: `mf5-b-${run}` })).id;
    const create = async (orgId: string, name: string, role: UserRole) =>
      (await users.createUser(orgId, { email: `${name}-${run}@mf5.local`, role })).id;
    admin = await create(orgA, 'admin', 'ADMIN');
    member = await create(orgA, 'member', 'MEMBER');
    colleague = await create(orgA, 'colleague', 'MEMBER');
    adminB = await create(orgB, 'admin-b', 'ADMIN');

    const practices = new PracticeApplicationService(prisma);
    practice = (
      await practices.createPractice({
        tenantId: orgA,
        userId: member,
        name: `Pratica mf5 ${run}`,
        kind: 'music',
      })
    ).id;
    attachment = (
      await practices.addAttachment({
        tenantId: orgA,
        userId: member,
        practiceId: practice,
        fileName: 'nota spese.txt',
        mimeType: 'text/plain',
        content: Buffer.from(`fattura ${run}`),
      })
    ).attachment.id;

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3005',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-mf5',
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
      complianceService: new ComplianceService(prisma),
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

  it('downloads an attachment only after the access check, never rendered inline', async () => {
    const url = `/practices/${practice}/attachments/${attachment}/download`;
    const own = await get(url, headers(orgA, member, 'MEMBER'));
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe(`fattura ${run}`);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['content-disposition']).toBe('attachment; filename="nota_spese.txt"');

    expect((await get(url, headers(orgA, admin, 'ADMIN'))).statusCode).toBe(200);
    expect((await get(url, headers(orgA, colleague, 'MEMBER'))).statusCode).toBe(404);
    expect((await get(url, headers(orgB, adminB, 'ADMIN'))).statusCode).toBe(404);
    // An existing attachment through another practice is not found either.
    const other = await new PracticeApplicationService(prisma).createPractice({
      tenantId: orgA,
      userId: admin,
      name: `Altra pratica ${run}`,
      kind: 'music',
    });
    const crossed = `/practices/${other.id}/attachments/${attachment}/download`;
    expect((await get(crossed, headers(orgA, admin, 'ADMIN'))).statusCode).toBe(404);
  });

  it('ends every token of a person at once (auth_version)', async () => {
    const before = headers(orgA, colleague, 'MEMBER');
    expect((await get('/practices', before)).statusCode).toBe(200);
    await revokeAllSessions(prisma, colleague, { userId: admin });
    expect((await get('/practices', before)).statusCode).toBe(401);
    const fresh = headers(orgA, colleague, 'MEMBER', { authVersion: 1 });
    expect((await get('/practices', fresh)).statusCode).toBe(200);
    const audit = await prisma.auditLog.count({
      where: { tenantId: orgA, eventType: 'SESSIONS_REVOKED' },
    });
    expect(audit).toBe(1);
  });

  it('accepts a session token only while the session is open and current', async () => {
    const { authVersion } = await prisma.user.findUniqueOrThrow({
      where: { id: colleague },
      select: { authVersion: true },
    });
    const session = await prisma.session.create({
      data: {
        userId: colleague,
        authVersion,
        refreshTokenHash: `mf5-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const h = headers(orgA, colleague, 'MEMBER', { authVersion, sessionId: session.id });
    expect((await get('/practices', h)).statusCode).toBe(200);
    const unknown = headers(orgA, colleague, 'MEMBER', { authVersion, sessionId: randomUUID() });
    expect((await get('/practices', unknown)).statusCode).toBe(401);

    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await get('/practices', h)).statusCode).toBe(401);
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + 3600_000), revokedAt: new Date() },
    });
    expect((await get('/practices', h)).statusCode).toBe(401);
  });

  it('lets an administrator revoke and reactivate a member, effective at the next request', async () => {
    const memberHeaders = headers(orgA, member, 'MEMBER');
    const adminHeaders = headers(orgA, admin, 'ADMIN');
    expect((await get('/members', memberHeaders)).statusCode).toBe(403);
    const list = await get('/members', adminHeaders);
    expect(list.statusCode).toBe(200);
    const members = list.json<{ data: { userId: string; email: string | null }[] }>().data;
    expect(members.map((m) => m.userId).sort()).toEqual([admin, member, colleague].sort());

    const revoke = (userId: string, h = adminHeaders) =>
      app.inject({
        method: 'POST',
        url: `/members/${userId}/revoke`,
        headers: h,
        payload: { reason: 'fine collaborazione' },
      });
    expect((await revoke(member)).statusCode).toBe(200);
    expect((await get('/practices', memberHeaders)).statusCode).toBe(401);
    const revoked = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgA, eventType: 'MEMBERSHIP_REVOKED' },
    });
    // The reason stays on the membership, not in the audit log.
    expect(revoked.payload).toEqual({ targetUserId: member });

    // A person of another organization is not found from here.
    expect((await revoke(adminB)).statusCode).toBe(404);
    // The last active administrator cannot be revoked.
    const last = await revoke(admin);
    expect(last.statusCode).toBe(409);
    expect(last.json<{ error: { code: string } }>().error.code).toBe('LAST_ADMIN');

    const reactivate = await app.inject({
      method: 'POST',
      url: `/members/${member}/reactivate`,
      headers: adminHeaders,
    });
    expect(reactivate.statusCode).toBe(200);
    expect((await get('/practices', memberHeaders)).statusCode).toBe(200);
  });

  it('refuses a disabled person on every organization until reactivated', async () => {
    await setUserStatus(prisma, member, 'DISABLED', { userId: null });
    expect((await get('/practices', headers(orgA, member, 'MEMBER'))).statusCode).toBe(401);
    await setUserStatus(prisma, member, 'ACTIVE', { userId: null });
    // Disabling ended the old tokens: a new one carries the new auth_version.
    expect((await get('/practices', headers(orgA, member, 'MEMBER'))).statusCode).toBe(401);
    const fresh = headers(orgA, member, 'MEMBER', { authVersion: 1 });
    expect((await get('/practices', fresh)).statusCode).toBe(200);
  });

  it('holds scheduled tasks and deliveries of a suspended organization', async () => {
    await prisma.tenant.update({ where: { id: orgB }, data: { status: 'SUSPENDED' } });
    try {
      const scheduler = new SchedulerService(prisma, new PracticeApplicationService(prisma));
      expect(await scheduler.tick(new Date(), orgB)).toEqual({
        triggeredCount: 0,
        skippedCount: 0,
      });
      expect(await prisma.schedulerJob.count({ where: { tenantId: orgB } })).toBe(0);

      const deliveries = await chatDeliveries(prisma, orgB, {}, () => Promise.resolve());
      expect(deliveries.map((d) => d.target)).toEqual(['organization']);
      const error = await deliveries[0].send().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(DeliveryError);
      expect((error as DeliveryError).permanent).toBe(false);
      expect((await get('/practices', headers(orgB, adminB, 'ADMIN'))).statusCode).toBe(401);
    } finally {
      await prisma.tenant.update({ where: { id: orgB }, data: { status: 'ACTIVE' } });
    }
    expect(await chatDeliveries(prisma, orgB, {}, () => Promise.resolve())).toEqual([]);
  });
});
