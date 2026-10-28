import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addDays,
  parseIsoDate,
  todayInRome,
  toIsoDate,
} from '../src/core/compliance/compliance.dates.js';
import {
  COMPLIANCE_DEADLINE_REMINDER,
  ComplianceService,
} from '../src/core/compliance/compliance.service.js';
import { ComplianceReminderHandler } from '../src/core/outbox/compliance-reminder.handler.js';
import { SchedulerService } from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { TelegramNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

// 11:00 in Italy: far from midnight, so the Italian calendar day is unambiguous.
const DAY0 = new Date('2026-11-02T10:00:00Z');
const dayAt = (days: number) => new Date(DAY0.getTime() + days * 86_400_000);
const dueIn = (days: number) => toIsoDate(addDays(parseIsoDate(todayInRome(DAY0))!, days));

// Exports are not under test here: the compliance check is a system task every tenant gets.
const noExports: Pick<PracticeApplicationService, 'exportPractices'> = {
  exportPractices: () => Promise.reject(new Error('exports are disabled for this tenant')),
};

describeWithDb('compliance deadline reminders (Step 6)', () => {
  let prisma1: PrismaClient;
  let prisma2: PrismaClient;

  beforeAll(async () => {
    prisma1 = createPrismaClient(DATABASE_URL!);
    prisma2 = createPrismaClient(DATABASE_URL!);
    await prisma1.$connect();
    await prisma2.$connect();
  });

  afterAll(async () => {
    await prisma1.$disconnect();
    await prisma2.$disconnect();
  });

  async function setupTenant() {
    const tenant = await new TenantRepository(prisma1).createTenant({
      name: `t-compliance-${randomUUID()}`,
      // Scheduled exports disabled: compliance reminders must run anyway.
      schedulerEnabled: false,
    });
    const users = new UserRepository(prisma1);
    const tag = randomUUID().slice(0, 8);
    const admin = await users.createUser(tenant.id, {
      email: `admin-${tag}@compliance.local`,
      role: 'ADMIN',
      telegramId: `a-${tag}`,
    });
    const member = await users.createUser(tenant.id, {
      email: `member-${tag}@compliance.local`,
      role: 'MEMBER',
      telegramId: `m-${tag}`,
    });
    const otherMember = await users.createUser(tenant.id, {
      email: `other-${tag}@compliance.local`,
      role: 'MEMBER',
      telegramId: `o-${tag}`,
    });
    return { tenantId: tenant.id, admin, member, otherMember };
  }

  async function remindersOf(deadlineId: string) {
    const rows = await prisma1.complianceReminder.findMany({ where: { deadlineId } });
    return rows.map((r) => r.thresholdDays).sort((a, b) => b - a);
  }

  async function reminderMessagesOf(tenantId: string, deadlineId: string) {
    const rows = await prisma1.outboxMessage.findMany({
      where: { tenantId, eventType: COMPLIANCE_DEADLINE_REMINDER },
    });
    return rows.filter((r) => (r.payload as { deadlineId?: string }).deadlineId === deadlineId);
  }

  it('sends exactly one reminder per threshold, with repeated ticks and two workers', async () => {
    const { tenantId, admin } = await setupTenant();
    const deadline = await new ComplianceService(prisma1, () => DAY0).createDeadline({
      tenantId,
      createdBy: admin.id,
      category: 'DURC',
      title: 'DURC cooperativa',
      dueDate: dueIn(20),
    });
    // Created 20 days ahead: the 30-day reminder is due at once.
    expect(await remindersOf(deadline.id)).toEqual([30]);

    const worker1 = new SchedulerService(prisma1, noExports, {
      complianceService: new ComplianceService(prisma1),
    });
    const worker2 = new SchedulerService(prisma2, noExports, {
      complianceService: new ComplianceService(prisma2),
    });

    // Days left: 20, 15, 7, 1, 0 (due today), -2 (overdue).
    for (const day of [0, 5, 13, 19, 20, 22]) {
      const now = dayAt(day);
      for (let round = 0; round < 2; round++) {
        await Promise.all([worker1.tick(now, tenantId), worker2.tick(now, tenantId)]);
      }
    }

    expect(await remindersOf(deadline.id)).toEqual([30, 15, 7, 1, 0]);
    const messages = await reminderMessagesOf(tenantId, deadline.id);
    expect(messages).toHaveLength(5);
    expect(
      messages.map((m) => (m.payload as { daysLeft: number }).daysLeft).sort((a, b) => b - a),
    ).toEqual([20, 15, 7, 1, 0]);
  });

  it('skips thresholds already passed when a deadline is created late', async () => {
    const { tenantId, admin } = await setupTenant();
    const deadline = await new ComplianceService(prisma1, () => DAY0).createDeadline({
      tenantId,
      createdBy: admin.id,
      category: 'VISITA_MEDICA',
      title: 'Visita medica',
      dueDate: dueIn(5),
    });
    await new SchedulerService(prisma1, noExports, {
      complianceService: new ComplianceService(prisma1),
    }).tick(DAY0, tenantId);

    // Only the 7-day reminder: no burst of 30, 15 and 7 at once.
    expect(await remindersOf(deadline.id)).toEqual([7]);
  });

  it('does not remind deadlines more than 30 days away or already closed', async () => {
    const { tenantId, admin } = await setupTenant();
    const service = new ComplianceService(prisma1, () => DAY0);
    const far = await service.createDeadline({
      tenantId,
      createdBy: admin.id,
      category: 'CERTIFICAZIONE_BIO',
      title: 'Certificato bio',
      dueDate: dueIn(45),
    });
    const closed = await service.createDeadline({
      tenantId,
      createdBy: admin.id,
      category: 'PATENTINO',
      title: 'Patentino fitosanitari',
      dueDate: dueIn(40),
    });
    expect(await remindersOf(far.id)).toEqual([]);

    await service.closeDeadline({ tenantId, idOrPrefix: closed.shortId, closedBy: admin.id });
    await new SchedulerService(prisma1, noExports, {
      complianceService: new ComplianceService(prisma1),
    }).tick(dayAt(35), tenantId);

    expect(await remindersOf(closed.id)).toEqual([]);
    expect(await remindersOf(far.id)).toEqual([15]);
  });

  it('delivers reminders on Telegram to the admins and the member concerned only', async () => {
    const { tenantId, admin, member } = await setupTenant();
    const deadline = await new ComplianceService(prisma1, () => DAY0).createDeadline({
      tenantId,
      createdBy: admin.id,
      userId: member.id,
      category: 'SICUREZZA_LAVORO',
      title: 'Aggiornamento formazione sicurezza',
      dueDate: dueIn(7),
    });

    const sent: Array<{ chatId: string; text: string }> = [];
    const telegram: TelegramNotifier = {
      sendDocument: () => Promise.resolve(),
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    };
    // The handler is driven directly on this deadline's message: a dispatcher would also claim
    // messages that other test files are working on in the shared outbox.
    const [message] = await reminderMessagesOf(tenantId, deadline.id);
    const deliveries = await new ComplianceReminderHandler(prisma1, { telegram }).resolveDeliveries(
      { ...message, attempts: 1, claimToken: randomUUID() },
    );
    for (const delivery of deliveries) await delivery.send();

    expect(sent.map((s) => s.chatId).sort()).toEqual([admin.telegramId, member.telegramId].sort());
    expect(sent[0]?.text).toContain('scade tra 7 giorni');
    expect(sent[0]?.text).toContain('Aggiornamento formazione sicurezza');
    expect(sent[0]?.text).toContain(`chiudi scadenza ${deadline.shortId}`);
  });
});
