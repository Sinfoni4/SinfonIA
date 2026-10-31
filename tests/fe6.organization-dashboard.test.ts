/**
 * FE6 backend (docs/PROGETTO_FRONTEND_V2.md §6, B10-B12): the numbers of the dashboard home
 * within the caller's scope, the activity log for administrators with only safe fields, and the
 * organization settings.
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
import { AuditService } from '../src/data/services/audit.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('organization in the dashboard (FE6)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId: string;
  let otherOrgId: string;
  let adminId: string;
  let operatorId: string;
  let memberId: string;
  let chatUserId: string;
  const adminEmail = `admin-${run}@fe6.local`;

  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });
  const patch = (url: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({ method: 'PATCH', url, payload: payload as object, headers });
  const admin = () => authHeaders(orgId, adminId, 'ADMIN');

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `fe6-${run}` })).id;
    otherOrgId = (await tenants.createTenant({ name: `fe6-altra-${run}` })).id;
    const users = new UserRepository(prisma);
    adminId = (await users.createUser(orgId, { email: adminEmail, role: 'ADMIN' })).id;
    operatorId = (
      await users.createUser(orgId, { email: `operatore-${run}@fe6.local`, role: 'OPERATOR' })
    ).id;
    memberId = (await users.createUser(orgId, { email: `membro-${run}@fe6.local`, role: 'MEMBER' }))
      .id;
    chatUserId = (
      await users.createUser(orgId, { email: `chat-${run}@local.invalid`, role: 'MEMBER' })
    ).id;
    const otherAdmin = (
      await users.createUser(otherOrgId, { email: `admin-altra-${run}@fe6.local`, role: 'ADMIN' })
    ).id;

    // Practices: two of the operator (one failed), one of the member.
    const practice = (userId: string, name: string, status: 'CREATED' | 'FAILED' = 'CREATED') =>
      prisma.practice.create({
        data: { tenantId: orgId, userId, status, payload: { schemaVersion: 2, name } },
      });
    const op1 = await practice(operatorId, 'Fattura fornitore');
    await practice(operatorId, 'Rimborso respinto', 'FAILED');
    const mine = await practice(memberId, 'Spese del membro');
    const attachment = (practiceId: string, fileName: string, extra: object) =>
      prisma.practiceAttachment.create({
        data: {
          tenantId: orgId,
          practiceId,
          fileName,
          mimeType: 'application/pdf',
          fileSize: 10,
          storagePath: `fe6/${run}/${fileName}`,
          ...extra,
        },
      });
    await attachment(op1.id, 'fattura.pdf', {
      ocrStatus: 'COMPLETED',
      ocrResult: { documentType: 'invoice', reviewRequired: true },
    });
    await attachment(mine.id, 'scontrino.jpg', { ocrStatus: 'FAILED' });
    await attachment(op1.id, 'ddt.pdf', {
      ocrStatus: 'COMPLETED',
      ocrResult: { documentType: 'delivery_note', reviewRequired: false },
    });

    // Deadlines: the organization's (overdue), the member's (soon), one far away.
    const compliance = new ComplianceService(prisma);
    const inDays = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    for (const [title, dueDate, userId] of [
      ['DURC scaduto', inDays(-3), null],
      ['Visita del membro', inDays(10), memberId],
      ['Rinnovo lontano', inDays(90), null],
    ] as const) {
      await compliance.createDeadline({
        tenantId: orgId,
        createdBy: adminId,
        userId,
        category: 'DURC',
        title,
        dueDate,
        notes: null,
      });
    }

    // Audit events: a role change with a target, a login with a session id, another org's event.
    const audit = new AuditService(prisma);
    await audit.logEvent({
      tenantId: orgId,
      userId: adminId,
      eventType: 'MEMBER_ROLE_CHANGED',
      payload: { targetUserId: operatorId, from: 'MEMBER', to: 'OPERATOR' },
    });
    await audit.logEvent({
      tenantId: orgId,
      userId: chatUserId,
      eventType: 'LOGIN_SUCCEEDED',
      payload: { sessionId: randomUUID(), secret: 'never shown' },
    });
    await audit.logEvent({
      tenantId: orgId,
      userId: adminId,
      eventType: 'PRACTICE_STATE_CHANGED',
      payload: { practiceId: op1.id, from: 'CREATED', to: 'VALIDATED' },
    });
    await audit.logEvent({
      tenantId: otherOrgId,
      userId: otherAdmin,
      eventType: 'MEMBER_ROLE_CHANGED',
      payload: { targetUserId: otherAdmin, from: 'ADMIN', to: 'ADMIN' },
    });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3008',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-fe6',
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
      complianceService: compliance,
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

  describe('home numbers (B10)', () => {
    type Summary = {
      practices: { total: number; byStatus: Record<string, number> };
      deadlines: { overdue: number; dueSoon: number; upcoming: Array<{ title: string }> };
      documents: {
        toReview: number;
        unreadable: number;
        items: Array<{ fileName: string; practiceName: string; reason: string }>;
      };
      recentPractices: Array<{ name: string }>;
    };

    it('counts the whole organization for staff', async () => {
      const res = await get('/dashboard/summary', authHeaders(orgId, operatorId, 'OPERATOR'));
      expect(res.statusCode).toBe(200);
      const s = res.json<{ data: Summary }>().data;
      expect(s.practices.total).toBe(3);
      expect(s.practices.byStatus).toMatchObject({ CREATED: 2, FAILED: 1, COMPLETED: 0 });
      expect([s.deadlines.overdue, s.deadlines.dueSoon]).toEqual([1, 1]);
      expect(s.deadlines.upcoming.map((d) => d.title)).toEqual([
        'DURC scaduto',
        'Visita del membro',
      ]);
      expect([s.documents.toReview, s.documents.unreadable]).toEqual([1, 1]);
      expect(s.documents.items.map((d) => [d.fileName, d.reason]).sort()).toEqual([
        ['fattura.pdf', 'review'],
        ['scontrino.jpg', 'unreadable'],
      ]);
      expect(s.recentPractices).toHaveLength(3);
    });

    it('shows a member only their own practices, documents and deadlines', async () => {
      const res = await get('/dashboard/summary', authHeaders(orgId, memberId, 'MEMBER'));
      const s = res.json<{ data: Summary }>().data;
      expect(s.practices.total).toBe(1);
      expect(s.recentPractices.map((p) => p.name)).toEqual(['Spese del membro']);
      expect(s.documents.items.map((d) => d.fileName)).toEqual(['scontrino.jpg']);
      expect(s.documents.toReview).toBe(0);
      expect(s.deadlines.upcoming.map((d) => d.title)).toEqual(['Visita del membro']);
    });
  });

  describe('activity log (B11)', () => {
    type AuditItem = {
      type: string;
      actor: { email: string | null } | null;
      target: { email: string | null } | null;
      practice: { name: string | null } | null;
      details: Record<string, unknown>;
    };

    it('shows administrators who did what, with emails and names, never ids or secrets', async () => {
      const res = await get('/audit?limit=100', admin());
      expect(res.statusCode).toBe(200);
      const { items, total } = res.json<{ data: { items: AuditItem[]; total: number } }>().data;
      // Deadlines created in the setup are recorded too.
      expect(total).toBeGreaterThanOrEqual(6);
      const role = items.find((i) => i.type === 'MEMBER_ROLE_CHANGED')!;
      expect(role.actor?.email).toBe(adminEmail);
      expect(role.target?.email).toBe(`operatore-${run}@fe6.local`);
      expect(role.details).toEqual({ from: 'MEMBER', to: 'OPERATOR' });
      const state = items.find((i) => i.type === 'PRACTICE_STATE_CHANGED')!;
      expect(state.practice?.name).toBe('Fattura fornitore');
      const login = items.find((i) => i.type === 'LOGIN_SUCCEEDED')!;
      expect(login.actor).toEqual({ userId: chatUserId, email: null });
      expect(login.details).toEqual({});
      const raw = res.body;
      expect(raw).not.toMatch(/sessionId|never shown|local\.invalid|fe6-altra/);
    });

    it('filters by type and person, and is for administrators only', async () => {
      const res = await get(`/audit?types=MEMBER_ROLE_CHANGED&userId=${adminId}`, admin());
      const items = res.json<{ data: { items: AuditItem[] } }>().data.items;
      expect(items.map((i) => i.type)).toEqual(['MEMBER_ROLE_CHANGED']);
      expect((await get('/audit', authHeaders(orgId, operatorId, 'OPERATOR'))).statusCode).toBe(
        403,
      );
      expect((await get('/audit?types=drop;table', admin())).statusCode).toBe(400);
    });
  });

  describe('organization settings (B12)', () => {
    type Settings = {
      name: string;
      type: string;
      scheduledExport: { enabled: boolean; frequency: string };
      reminderDays: number[];
    };

    it('shows and changes name and scheduled export, and records the change', async () => {
      const before = await get('/organization', admin());
      expect(before.json<{ data: Settings }>().data).toMatchObject({
        name: `fe6-${run}`,
        type: 'COMPANY',
        scheduledExport: { enabled: false, frequency: 'monthly' },
        reminderDays: [30, 15, 7, 1],
      });
      const res = await patch(
        '/organization',
        {
          name: `  Cooperativa   FE6 ${run} `,
          scheduledExport: { enabled: true, frequency: 'weekly' },
        },
        admin(),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: Settings }>().data).toMatchObject({
        name: `Cooperativa FE6 ${run}`,
        scheduledExport: { enabled: true, frequency: 'weekly' },
      });
      const event = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId: orgId, eventType: 'ORGANIZATION_SETTINGS_CHANGED' },
      });
      expect(event.payload).toEqual({
        name: `Cooperativa FE6 ${run}`,
        scheduledExport: true,
        frequency: 'weekly',
      });
      // Nothing changed: nothing recorded.
      await patch('/organization', { name: `Cooperativa FE6 ${run}` }, admin());
      expect(
        await prisma.auditLog.count({
          where: { tenantId: orgId, eventType: 'ORGANIZATION_SETTINGS_CHANGED' },
        }),
      ).toBe(1);
    });

    it('refuses bad names, the type, and non-administrators', async () => {
      expect((await patch('/organization', { name: 'x' }, admin())).statusCode).toBe(400);
      expect((await patch('/organization', { type: 'NETWORK' }, admin())).statusCode).toBe(400);
      const asOperator = authHeaders(orgId, operatorId, 'OPERATOR');
      expect((await get('/organization', asOperator)).statusCode).toBe(403);
      expect((await patch('/organization', { name: 'Altro nome' }, asOperator)).statusCode).toBe(
        403,
      );
    });
  });
});
