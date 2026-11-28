/**
 * Fase 1B: how sure a deadline is. Confirmed (default) is reminded as usual; to be checked is
 * reminded saying so until someone confirms it; for information only is listed, never reminded
 * nor counted among the late or due ones.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatReminderMessage } from '../src/core/compliance/compliance.messages.js';
import {
  COMPLIANCE_DEADLINE_REMINDER,
  ComplianceService,
  type ComplianceReminderPayload,
} from '../src/core/compliance/compliance.service.js';
import { dashboardSummary } from '../src/core/dashboard/dashboard.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { formatDeadlineList } from '../src/interface/telegram/compliance.command.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('certainty in the messages', () => {
  const payload: ComplianceReminderPayload = {
    deadlineId: 'ab12cd34-0000-4000-8000-000000000000',
    category: 'DURC',
    title: 'DURC',
    dueDate: '2026-12-10',
    daysLeft: 7,
    thresholdDays: 7,
    userId: null,
  };

  it('says a reminder is to be checked, and nothing for a confirmed or older one', () => {
    expect(formatReminderMessage({ ...payload, certainty: 'TO_VERIFY' })).toContain(
      'Da verificare',
    );
    expect(formatReminderMessage({ ...payload, certainty: 'CONFIRMED' })).not.toContain(
      'verificare',
    );
    expect(formatReminderMessage(payload)).not.toContain('verificare');
  });

  it('labels in the chat list only what is not confirmed', () => {
    const base = {
      id: payload.deadlineId,
      shortId: 'ab12cd34',
      category: 'DURC' as const,
      dueDate: '2026-12-10',
      daysLeft: 7,
      status: 'OPEN' as const,
      verifiedAt: null,
      userId: null,
      notes: null,
      closedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const text = formatDeadlineList([
      { ...base, title: 'Sicura', certainty: 'CONFIRMED' },
      { ...base, title: 'Dubbia', certainty: 'TO_VERIFY' },
      { ...base, title: 'Solo nota', certainty: 'INFORMATIONAL' },
    ]);
    expect(text).toMatch(/Sicura\n[^\n]*codice/);
    expect(text).not.toMatch(/Sicura\n[^\n]*confermata/);
    expect(text).toMatch(/Dubbia\n[^\n]*da verificare/);
    expect(text).toMatch(/Solo nota\n[^\n]*informativa/);
  });
});

describe.runIf(Boolean(DATABASE_URL))('certainty of the deadlines with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let service: ComplianceService;
  let tenantId = '';
  let adminId = '';
  const now = new Date('2026-11-28T09:00:00Z');
  const create = (title: string, certainty?: 'CONFIRMED' | 'TO_VERIFY' | 'INFORMATIONAL') =>
    service.createDeadline({
      tenantId,
      createdBy: adminId,
      category: 'DURC',
      title: `${title} ${run}`,
      dueDate: '2026-12-03',
      ...(certainty ? { certainty } : {}),
    });
  const remindersOf = (deadlineId: string) =>
    prisma.outboxMessage.findMany({
      where: {
        tenantId,
        eventType: COMPLIANCE_DEADLINE_REMINDER,
        payload: { path: ['deadlineId'], equals: deadlineId },
      },
      select: { payload: true },
    });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (await new TenantRepository(prisma).createTenant({ name: `Certezza ${run}` })).id;
    adminId = (
      await new UserRepository(prisma).createUser(tenantId, {
        email: `admin-${run}@certainty.local`,
        role: 'ADMIN',
      })
    ).id;
    service = new ComplianceService(prisma, () => now);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('confirms a deadline when nothing is said', async () => {
    const created = await create('Senza indicazione');
    expect(created.certainty).toBe('CONFIRMED');
    expect(created.verifiedAt).toBeNull();
  });

  it('reminds one to be checked, saying so in the payload', async () => {
    const created = await create('Da controllare', 'TO_VERIFY');
    const sent = await remindersOf(created.id);
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as ComplianceReminderPayload).certainty).toBe('TO_VERIFY');
  });

  it('never reminds one for information only, nor counts it in the home', async () => {
    const created = await create('Solo informativa', 'INFORMATIONAL');
    expect(await remindersOf(created.id)).toHaveLength(0);
    const run2 = await service.sendDueReminders({ tenantId, now });
    expect(run2.checked).toBeGreaterThan(0);
    expect(await remindersOf(created.id)).toHaveLength(0);

    const summary = await dashboardSummary(prisma, service, { tenantId }, now);
    const listed = summary.deadlines.upcoming.find((d) => d.id === created.id);
    expect(listed?.certainty).toBe('INFORMATIONAL');
    const counted = summary.deadlines.overdue + summary.deadlines.dueSoon;
    const all = await service.listDeadlines({ tenantId, status: 'OPEN', withinDays: 30 });
    expect(counted).toBe(all.filter((d) => d.certainty !== 'INFORMATIONAL').length);
  });

  it('records who confirmed one to be checked, and logs every change', async () => {
    const created = await create('Verificata poi', 'TO_VERIFY');
    const confirmed = await service.setCertainty({
      tenantId,
      id: created.id,
      certainty: 'CONFIRMED',
      changedBy: adminId,
    });
    expect(confirmed.certainty).toBe('CONFIRMED');
    expect(confirmed.verifiedAt).toBe(now.toISOString());
    const row = await prisma.complianceDeadline.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.verifiedBy).toBe(adminId);

    // The same state again changes nothing and logs nothing.
    await service.setCertainty({
      tenantId,
      id: created.id,
      certainty: 'CONFIRMED',
      changedBy: adminId,
    });
    const log = await prisma.auditLog.findMany({
      where: { tenantId, eventType: 'COMPLIANCE_DEADLINE_CERTAINTY_CHANGED' },
      select: { payload: true },
    });
    expect(
      log.filter((l) => (l.payload as { deadlineId: string }).deadlineId === created.id),
    ).toEqual([{ payload: { deadlineId: created.id, from: 'TO_VERIFY', to: 'CONFIRMED' } }]);
  });

  it('reminds at once a deadline that stops being for information only', async () => {
    const created = await create('Diventa vera', 'INFORMATIONAL');
    expect(await remindersOf(created.id)).toHaveLength(0);
    await service.setCertainty({
      tenantId,
      id: created.id,
      certainty: 'TO_VERIFY',
      changedBy: adminId,
    });
    expect(await remindersOf(created.id)).toHaveLength(1);
  });

  it('filters the list by certainty, and keeps other organizations out', async () => {
    const list = await service.listDeadlines({ tenantId, certainty: 'INFORMATIONAL' });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((d) => d.certainty === 'INFORMATIONAL')).toBe(true);

    const other = (await new TenantRepository(prisma).createTenant({ name: `Altra ${run}` })).id;
    const theirs = list[0];
    await expect(
      service.setCertainty({
        tenantId: other,
        id: theirs.id,
        certainty: 'CONFIRMED',
        changedBy: adminId,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
