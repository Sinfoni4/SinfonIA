import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { parseComplianceCommand } from '../src/core/compliance/compliance.commands.js';
import {
  daysUntil,
  parseIsoDate,
  parseItalianDate,
  reminderThresholdFor,
  todayInRome,
} from '../src/core/compliance/compliance.dates.js';
import { formatReminderMessage } from '../src/core/compliance/compliance.messages.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import {
  executeComplianceCommand,
  upcomingRemindersText,
} from '../src/interface/telegram/compliance.command.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ContextService } from '../src/ai/context/context.service.js';
import type {
  ComplianceDeadlineView,
  ComplianceService as ComplianceServiceType,
} from '../src/core/compliance/compliance.service.js';
import type { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

describe('compliance dates', () => {
  it('uses the Italian calendar day for "today"', () => {
    // 23:30 UTC on 31 December is already 1 January in Italy.
    expect(todayInRome(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    // Summer time: 22:30 UTC on 30 June is 00:30 on 1 July in Italy.
    expect(todayInRome(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01');
  });

  it('parses ISO and Italian dates and rejects impossible ones', () => {
    expect(parseIsoDate('2026-12-31')?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseItalianDate('31/12/2026')?.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(parseItalianDate('1.3.2027')?.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(parseItalianDate('31/02/2026')).toBeNull();
  });

  it('counts whole days, negative when overdue', () => {
    const due = parseIsoDate('2026-11-10')!;
    expect(daysUntil(due, '2026-11-03')).toBe(7);
    expect(daysUntil(due, '2026-11-10')).toBe(0);
    expect(daysUntil(due, '2026-11-12')).toBe(-2);
  });

  it.each([
    [45, null],
    [31, null],
    [30, 30],
    [20, 30],
    [15, 15],
    [8, 15],
    [7, 7],
    [2, 7],
    [1, 1],
    [0, 0],
    [-5, 0],
  ])('with %i days left the due reminder is %s', (daysLeft, threshold) => {
    expect(reminderThresholdFor(daysLeft)).toBe(threshold);
  });
});

describe('compliance Telegram commands', () => {
  it('parses list, create and close commands', () => {
    expect(parseComplianceCommand('Scadenze')).toEqual({ type: 'LIST_DEADLINES' });
    expect(parseComplianceCommand('nuova scadenza durc 31/12/2026 DURC cooperativa')).toEqual({
      type: 'CREATE_DEADLINE',
      payload: { category: 'DURC', dueDate: '2026-12-31', title: 'DURC cooperativa' },
    });
    expect(parseComplianceCommand('nuova scadenza visita 05/03/2027 Visita Mario')).toMatchObject({
      payload: { category: 'VISITA_MEDICA', dueDate: '2027-03-05' },
    });
    expect(parseComplianceCommand('chiudi scadenza AB12CD34')).toEqual({
      type: 'CLOSE_DEADLINE',
      payload: { code: 'ab12cd34' },
    });
    expect(parseComplianceCommand('lista pratiche')).toBeNull();
  });

  it.each([
    ['nuova scadenza ferie 31/12/2026 Ferie', 'Tipo non riconosciuto'],
    ['nuova scadenza durc 31/02/2026 DURC', 'Data non valida'],
    ['nuova scadenza durc 31/12/2026', 'Manca la descrizione'],
    ['chiudi scadenza boh', 'codice della scadenza'],
  ])('explains what is wrong in "%s"', (input, reason) => {
    const command = parseComplianceCommand(input);
    expect(command?.type).toBe('INVALID_COMPLIANCE_COMMAND');
    expect(command?.type === 'INVALID_COMPLIANCE_COMMAND' && command.reason).toContain(reason);
  });

  const view: ComplianceDeadlineView = {
    id: 'ab12cd34-0000-4000-8000-000000000000',
    shortId: 'ab12cd34',
    category: 'DURC',
    title: 'DURC cooperativa',
    dueDate: '2026-12-31',
    daysLeft: 5,
    status: 'OPEN',
    userId: null,
    notes: null,
    closedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
  };

  function fakeService() {
    return {
      listDeadlines: vi.fn().mockResolvedValue([view]),
      createDeadline: vi.fn().mockResolvedValue(view),
      closeDeadline: vi.fn().mockResolvedValue({ ...view, status: 'CLOSED' }),
    } satisfies Pick<ComplianceServiceType, 'listDeadlines' | 'createDeadline' | 'closeDeadline'>;
  }

  it('lets members list only their own deadlines and not manage them', async () => {
    const complianceService = fakeService();
    const ctx = { complianceService, tenantId: 't', userId: 'u-member', role: 'MEMBER' as const };

    const list = await executeComplianceCommand({ type: 'LIST_DEADLINES' }, ctx);
    expect(list).toContain('DURC cooperativa');
    expect(list).toContain('codice ab12cd34');
    expect(complianceService.listDeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-member', status: 'OPEN' }),
    );

    const refused = await executeComplianceCommand(
      { type: 'CLOSE_DEADLINE', payload: { code: 'ab12cd34' } },
      ctx,
    );
    expect(refused).toContain('operatore o un amministratore');
    expect(complianceService.closeDeadline).not.toHaveBeenCalled();
  });

  it('lets operators create and close deadlines', async () => {
    const complianceService = fakeService();
    const ctx = { complianceService, tenantId: 't', userId: 'u-op', role: 'OPERATOR' as const };

    const created = await executeComplianceCommand(
      {
        type: 'CREATE_DEADLINE',
        payload: { category: 'DURC', dueDate: '2026-12-31', title: 'DURC cooperativa' },
      },
      ctx,
    );
    expect(created).toContain('Scadenza registrata');
    expect(created).toContain('31/12/2026');

    const closed = await executeComplianceCommand(
      { type: 'CLOSE_DEADLINE', payload: { code: 'ab12cd34' } },
      ctx,
    );
    expect(closed).toContain('Scadenza chiusa');
    expect(complianceService.closeDeadline).toHaveBeenCalledWith(
      expect.objectContaining({ idOrPrefix: 'ab12cd34', closedBy: 'u-op' }),
    );
  });

  it.each([
    [45, 'Promemoria: 30 giorni, 15 giorni, 7 giorni, 1 giorno e il giorno della scadenza.'],
    [20, 'Promemoria: 15 giorni, 7 giorni, 1 giorno e il giorno della scadenza.'],
    // Found in staging: with 5 days left the bot promised reminders at 30, 15 and 7 days.
    [5, 'Promemoria: 1 giorno e il giorno della scadenza.'],
    [1, 'Promemoria: il giorno della scadenza.'],
    [0, 'La scadenza è già oggi o passata: ricevi subito un avviso.'],
  ])('lists only the reminders still to come with %i days left', (daysLeft, text) => {
    expect(upcomingRemindersText(daysLeft)).toBe(text);
  });

  it('formats reminders for each moment', () => {
    const base = {
      deadlineId: view.id,
      category: 'DURC' as const,
      title: 'DURC cooperativa',
      dueDate: '2026-12-31',
      thresholdDays: 7,
      userId: null,
    };
    expect(formatReminderMessage({ ...base, daysLeft: 7 })).toContain('scade tra 7 giorni');
    expect(formatReminderMessage({ ...base, daysLeft: 1 })).toContain('scade domani');
    expect(formatReminderMessage({ ...base, daysLeft: 0 })).toContain('scade oggi');
    expect(formatReminderMessage({ ...base, daysLeft: -3 })).toContain('scaduta da 3 giorni');
    expect(formatReminderMessage({ ...base, daysLeft: 7 })).toContain('31/12/2026');
  });
});

describeWithDb('compliance REST API', () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let adminId: string;
  let memberId: string;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenant = await new TenantRepository(prisma).createTenant({
      name: `t-compliance-api-${randomUUID()}`,
    });
    tenantId = tenant.id;
    const users = new UserRepository(prisma);
    adminId = (await users.createUser(tenantId, { email: 'a@api.local', role: 'ADMIN' })).id;
    memberId = (await users.createUser(tenantId, { email: 'm@api.local', role: 'MEMBER' })).id;

    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3014',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-compliance-test',
      ...TEST_AUTH_ENV,
    });
    const practiceService = {} as PracticeApplicationService;
    app = buildServer(config, createLogger(config), {
      principals: testPrincipals(),
      practiceService,
      complianceService: new ComplianceService(prisma),
      interpreterService: new InterpreterService({ complete: vi.fn() }),
      executorService: new ExecutorService({ practiceService }),
      contextService: {} as ContextService,
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it('creates, lists and closes deadlines', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/compliance/deadlines',
      headers: authHeaders(tenantId, adminId, 'ADMIN'),
      payload: {
        category: 'VISITA_MEDICA',
        title: 'Visita medica socio',
        dueDate: inDays(60),
        userId: memberId,
      },
    });
    expect(created.statusCode).toBe(201);
    const deadline = created.json<{ data: ComplianceDeadlineView }>().data;
    expect(deadline).toMatchObject({ category: 'VISITA_MEDICA', status: 'OPEN', userId: memberId });

    // A member sees the deadlines that refer to them.
    const memberList = await app.inject({
      method: 'GET',
      url: '/compliance/deadlines?status=OPEN',
      headers: authHeaders(tenantId, memberId, 'MEMBER'),
    });
    expect(memberList.statusCode).toBe(200);
    expect(memberList.json<{ data: ComplianceDeadlineView[] }>().data.map((d) => d.id)).toEqual([
      deadline.id,
    ]);

    const closed = await app.inject({
      method: 'POST',
      url: `/compliance/deadlines/${deadline.id}/close`,
      headers: authHeaders(tenantId, adminId, 'ADMIN'),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<{ data: ComplianceDeadlineView }>().data.status).toBe('CLOSED');

    const audit = await prisma.auditLog.findMany({
      where: { tenantId, eventType: { startsWith: 'COMPLIANCE_DEADLINE_' } },
    });
    expect(audit.map((a) => a.eventType).sort()).toEqual([
      'COMPLIANCE_DEADLINE_CLOSED',
      'COMPLIANCE_DEADLINE_CREATED',
    ]);
  });

  it('forbids members from creating or closing deadlines', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compliance/deadlines',
      headers: authHeaders(tenantId, memberId, 'MEMBER'),
      payload: { category: 'DURC', title: 'DURC', dueDate: inDays(10) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects invalid input', async () => {
    for (const payload of [
      { category: 'FERIE', title: 'x', dueDate: inDays(10) },
      { category: 'DURC', title: 'x', dueDate: '2026-02-30' },
      { category: 'DURC', title: '', dueDate: inDays(10) },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/compliance/deadlines',
        headers: authHeaders(tenantId, adminId, 'ADMIN'),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('does not let a tenant close another tenant deadline', async () => {
    const other = await new TenantRepository(prisma).createTenant({
      name: `t-compliance-other-${randomUUID()}`,
    });
    const otherAdmin = await new UserRepository(prisma).createUser(other.id, {
      email: 'a@other.local',
      role: 'ADMIN',
    });
    const created = await app.inject({
      method: 'POST',
      url: '/compliance/deadlines',
      headers: authHeaders(tenantId, adminId, 'ADMIN'),
      payload: { category: 'DURC', title: 'DURC', dueDate: inDays(90) },
    });
    const id = created.json<{ data: ComplianceDeadlineView }>().data.id;

    const res = await app.inject({
      method: 'POST',
      url: `/compliance/deadlines/${id}/close`,
      headers: authHeaders(other.id, otherAdmin.id, 'ADMIN'),
    });
    expect(res.statusCode).toBe(404);
  });
});
