import { describe, expect, it } from 'vitest';

import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import {
  computeIdempotencyKey,
  computeNextRun,
  computePeriodKey,
  resolveDynamicPayload,
  SchedulerService,
} from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { SchedulerRepository } from '../src/data/repositories/scheduler.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

describe('scheduler unit helpers', () => {
  it('resolves dynamic placeholders in payload', () => {
    const fixedDate = new Date('2026-05-15T12:00:00Z');
    const resolved = resolveDynamicPayload(
      {
        year: 'dynamic:currentYear',
        month: 'dynamic:currentMonth',
        today: 'dynamic:today',
        staticField: 'hello',
      },
      fixedDate,
    );

    expect(resolved).toEqual({
      year: 2026,
      month: 5,
      today: '2026-05-15',
      staticField: 'hello',
    });
  });

  it('computes deterministic period keys for daily, weekly, monthly', () => {
    const fixedDate = new Date('2026-10-26T10:00:00Z');

    expect(computePeriodKey('daily', fixedDate)).toBe('2026-10-26');
    expect(computePeriodKey('monthly', fixedDate)).toBe('2026-10');
    expect(computePeriodKey('weekly', fixedDate)).toContain('2026-W');
  });

  it('computes next run dates accurately', () => {
    const fixedDate = new Date('2026-10-26T10:00:00Z');

    const nextDaily = computeNextRun('daily', fixedDate);
    expect(nextDaily.getDate()).toBe(27);

    const nextMonthly = computeNextRun('monthly', fixedDate);
    expect(nextMonthly.getMonth()).toBe(10); // November (0-indexed: 10)
    expect(nextMonthly.getDate()).toBe(1);
  });

  it('computes deterministic idempotency keys', () => {
    const fixedDate = new Date('2026-10-26T10:00:00Z');
    const key1 = computeIdempotencyKey('t-123', 'EXPORT_PRACTICES', 'monthly', fixedDate);
    const key2 = computeIdempotencyKey('t-123', 'EXPORT_PRACTICES', 'monthly', fixedDate);

    expect(key1).toBe('t-123:EXPORT_PRACTICES:monthly:2026-10');
    expect(key1).toBe(key2);
  });
});

describe('durable scheduler with PostgreSQL (Phase 2C)', () => {
  itWithDb('handles advisory locks concurrently and releases properly', async () => {
    const prisma1 = createPrismaClient(DATABASE_URL!);
    const prisma2 = createPrismaClient(DATABASE_URL!);
    await prisma1.$connect();
    await prisma2.$connect();

    try {
      const repo1 = new SchedulerRepository(prisma1);
      const repo2 = new SchedulerRepository(prisma2);

      const lockKey = 'test-concurrent-lock';

      // While worker 1 holds the lock, worker 2 cannot run the guarded section
      const outer = await repo1.withAdvisoryLock(lockKey, async () => {
        const inner = await repo2.withAdvisoryLock(lockKey, () => Promise.resolve('worker2'));
        expect(inner.executed).toBe(false);
        return 'worker1';
      });
      expect(outer).toEqual({ executed: true, result: 'worker1' });

      // Once worker 1 is done, worker 2 can acquire the lock
      const after = await repo2.withAdvisoryLock(lockKey, () => Promise.resolve('worker2'));
      expect(after).toEqual({ executed: true, result: 'worker2' });
    } finally {
      await prisma1.$disconnect();
      await prisma2.$disconnect();
    }
  });

  itWithDb('never leaks the advisory lock on pooled connections or on failure', async () => {
    const prisma1 = createPrismaClient(DATABASE_URL!);
    const prisma2 = createPrismaClient(DATABASE_URL!);
    await prisma1.$connect();
    await prisma2.$connect();

    try {
      const repo1 = new SchedulerRepository(prisma1);
      const repo2 = new SchedulerRepository(prisma2);
      const lockKey = 'test-lock-no-leak';

      // Regression: session-level locks acquired and released through the pool could stay held
      // on another connection. Interleave pool usage across many runs, then check from worker 2.
      for (let i = 0; i < 10; i++) {
        const res = await repo1.withAdvisoryLock(lockKey, async () => {
          await Promise.all([prisma1.$queryRaw`SELECT 1`, prisma1.$queryRaw`SELECT 1`]);
          return i;
        });
        expect(res.executed).toBe(true);
      }

      await expect(
        repo1.withAdvisoryLock(lockKey, () => Promise.reject(new Error('task failed'))),
      ).rejects.toThrow('task failed');

      const after = await repo2.withAdvisoryLock(lockKey, () => Promise.resolve('ok'));
      expect(after).toEqual({ executed: true, result: 'ok' });
    } finally {
      await prisma1.$disconnect();
      await prisma2.$disconnect();
    }
  });

  itWithDb('reports a task that outlives the lock transaction as executed', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    try {
      const repo = new SchedulerRepository(prisma);
      const res = await repo.withAdvisoryLock(
        'test-lock-timeout',
        () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 400)),
        { timeoutMs: 100 },
      );
      expect(res).toEqual({ executed: true, result: 'done' });
    } finally {
      await prisma.$disconnect();
    }
  });

  itWithDb('exports practices of every tenant user, not only the admin', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);

      const tenant = await tenantRepo.createTenant({
        name: 't-scheduler-tenant-wide',
        schedulerEnabled: true,
        schedulerFrequency: 'daily',
      });
      const admin = await userRepo.createUser(tenant.id, {
        email: 'admin@sched-wide.local',
        role: 'ADMIN',
      });
      const member = await userRepo.createUser(tenant.id, {
        email: 'member@sched-wide.local',
        role: 'MEMBER',
      });

      const practiceService = new PracticeApplicationService(prisma);
      await practiceService.createPractice({
        tenantId: tenant.id,
        userId: admin.id,
        name: 'Admin',
      });
      await practiceService.createPractice({
        tenantId: tenant.id,
        userId: member.id,
        name: 'Member',
      });

      const schedulerService = new SchedulerService(prisma, practiceService);
      const tick = await schedulerService.tick(new Date(), tenant.id);
      // The export plus the daily compliance check every tenant gets.
      expect(tick.triggeredCount).toBe(2);

      const outbox = await prisma.outboxMessage.findFirst({ where: { tenantId: tenant.id } });
      expect((outbox?.payload as { practiceCount?: number }).practiceCount).toBe(2);
    } finally {
      await prisma.$disconnect();
    }
  });

  itWithDb(
    'executes scheduled job idempotently, prevents burst, and writes to outbox',
    async () => {
      const prisma = createPrismaClient(DATABASE_URL!);
      await prisma.$connect();

      try {
        const tenantRepo = new TenantRepository(prisma);
        const userRepo = new UserRepository(prisma);

        const tenant = await tenantRepo.createTenant({
          name: 't-scheduler-durable',
          schedulerEnabled: true,
          schedulerFrequency: 'daily',
        });

        await userRepo.createUser(tenant.id, {
          email: 'admin@sched-durable.local',
          role: 'ADMIN',
        });

        let exportCount = 0;
        const mockPracticeService: Pick<PracticeApplicationService, 'exportPractices'> = {
          exportPractices: async () => {
            await Promise.resolve();
            exportCount++;
            return {
              filter: { type: 'today' },
              title: 'Export Pratiche Oggi',
              csv: 'Nome,Data Creazione\nTest,2026-10-26T00:00:00Z\n',
              count: 0,
            };
          },
        };

        const schedulerService = new SchedulerService(prisma, mockPracticeService);
        const now = new Date('2026-10-26T12:00:00Z');

        // First tick: should execute
        const tick1 = await schedulerService.tick(now, tenant.id);
        // The export plus the daily compliance check every tenant gets.
        expect(tick1.triggeredCount).toBe(2);
        expect(exportCount).toBe(1);

        // Second tick: should be skipped (idempotent, zero burst on restart/re-tick)
        const tick2 = await schedulerService.tick(now, tenant.id);
        expect(tick2.triggeredCount).toBe(0);
        expect(tick2.skippedCount).toBe(2);
        expect(exportCount).toBe(1); // Not called again

        // Verify scheduler_run record in DB
        const run = await prisma.schedulerRun.findFirst({
          where: { tenantId: tenant.id },
        });
        expect(run).not.toBeNull();
        expect(run?.status).toBe('COMPLETED');
        expect(run?.idempotencyKey).toContain(tenant.id);

        // Verify outbox message record in DB
        const outbox = await prisma.outboxMessage.findFirst({
          where: { tenantId: tenant.id },
        });
        expect(outbox).not.toBeNull();
        expect(outbox?.eventType).toBe('PRACTICE_EXPORT_GENERATED');
        expect(outbox?.status).toBe('PENDING');
      } finally {
        await prisma.$disconnect();
      }
    },
  );
});
