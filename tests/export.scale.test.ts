import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { exportFilterRange } from '../src/core/practice/practice.export.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

const PRACTICES = 10_000;
// About 5 KB of payload per practice, as after OCR enrichment: ~50 MB if all were loaded.
const BULKY_PAYLOAD = { notes: 'x'.repeat(5_000) };
// Memory the export may add while it runs (it used to load every practice with its payload).
const MAX_HEAP_GROWTH_BYTES = 30 * 1024 * 1024;

describe('export date ranges', () => {
  const now = new Date(2026, 9, 28, 15, 30);
  it('turns filters into [from, to) ranges in local time', () => {
    expect(exportFilterRange({ type: 'today' }, now)).toEqual({
      from: new Date(2026, 9, 28),
      to: new Date(2026, 9, 29),
    });
    expect(exportFilterRange({ type: 'month' }, now)).toEqual({
      from: new Date(2026, 9, 1),
      to: new Date(2026, 10, 1),
    });
    expect(exportFilterRange({ type: 'year', value: 2025 }, now)).toEqual({
      from: new Date(2025, 0, 1),
      to: new Date(2026, 0, 1),
    });
    expect(exportFilterRange({ type: 'all' }, now)).toEqual({});
  });
});

describeWithDb('export of 10,000 practices (Step 8)', () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (
      await new TenantRepository(prisma).createTenant({ name: `t-export-${randomUUID()}` })
    ).id;
    const user = await new UserRepository(prisma).createUser(tenantId, {
      email: `export-${randomUUID()}@scale.local`,
      role: 'ADMIN',
    });
    const thisYear = new Date().getFullYear();
    for (let start = 0; start < PRACTICES; start += 1000) {
      await prisma.practice.createMany({
        data: Array.from({ length: 1000 }, (_, i) => {
          const n = start + i;
          return {
            tenantId,
            userId: user.id,
            payload: { name: `Pratica ${String(n).padStart(5, '0')}`, ...BULKY_PAYLOAD },
            // One practice in ten belongs to last year: the year filter must leave them out.
            createdAt:
              n % 10 === 0 ? new Date(thisYear - 1, 5, 1) : new Date(thisYear, 0, 2, 0, 0, n % 60),
          };
        }),
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.practice.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('exports every practice in batches, within the memory budget', async () => {
    const service = new PracticeApplicationService(prisma);
    const heapBefore = process.memoryUsage().heapUsed;
    let peak = heapBefore;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);

    const started = Date.now();
    const exported = await service.exportPractices({ tenantId, filter: { type: 'all' } });
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().heapUsed);

    expect(exported.count).toBe(PRACTICES);
    const lines = exported.csv.trimEnd().split('\n');
    expect(lines[0]).toBe('Nome,Data Creazione');
    expect(lines).toHaveLength(PRACTICES + 1);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(PRACTICES);
    expect(peak - heapBefore).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('applies the date filter in the database', async () => {
    const exported = await new PracticeApplicationService(prisma).exportPractices({
      tenantId,
      filter: { type: 'year', value: new Date().getFullYear() - 1 },
    });
    expect(exported.count).toBe(PRACTICES / 10);
  }, 60_000);
});
