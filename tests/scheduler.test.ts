import { describe, expect, it } from 'vitest';

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

import type { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';

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

      // Worker 1 acquires lock
      const acquired1 = await repo1.tryAcquireAdvisoryLock(lockKey);
      expect(acquired1).toBe(true);

      // Worker 2 attempts same lock concurrently -> fails
      const acquired2 = await repo2.tryAcquireAdvisoryLock(lockKey);
      expect(acquired2).toBe(false);

      // Worker 1 releases lock
      const released1 = await repo1.releaseAdvisoryLock(lockKey);
      expect(released1).toBe(true);

      // Worker 2 can now acquire lock
      const acquired2After = await repo2.tryAcquireAdvisoryLock(lockKey);
      expect(acquired2After).toBe(true);

      await repo2.releaseAdvisoryLock(lockKey);
    } finally {
      await prisma1.$disconnect();
      await prisma2.$disconnect();
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
              practices: [] as never,
            };
          },
        };

        const schedulerService = new SchedulerService(prisma, mockPracticeService);
        const now = new Date('2026-10-26T12:00:00Z');

        // First tick: should execute
        const tick1 = await schedulerService.tick(now, tenant.id);
        expect(tick1.triggeredCount).toBe(1);
        expect(exportCount).toBe(1);

        // Second tick: should be skipped (idempotent, zero burst on restart/re-tick)
        const tick2 = await schedulerService.tick(now, tenant.id);
        expect(tick2.triggeredCount).toBe(0);
        expect(tick2.skippedCount).toBe(1);
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
