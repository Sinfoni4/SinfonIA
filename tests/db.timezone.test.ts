import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

// Found in staging: on a server with TimeZone=Europe/Berlin every timestamp written by Prisma was
// stored one hour early (two in summer), and outbox messages requeued with now() waited an hour.
describeWithDb('database timestamps', () => {
  it('runs sessions in UTC so Prisma timestamps are stored at the real instant', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    try {
      const [setting] = await prisma.$queryRaw<Array<{ tz: string }>>`
        SELECT current_setting('TimeZone') AS tz`;
      expect(setting?.tz).toBe('UTC');

      const before = Date.now();
      const tenant = await new TenantRepository(prisma).createTenant({
        name: `t-timezone-${randomUUID()}`,
      });
      // Epoch seconds are absolute: they do not depend on any session time zone.
      const [row] = await prisma.$queryRaw<Array<{ epoch: number; db_now: number }>>`
        SELECT extract(epoch FROM created_at)::float8 AS epoch,
               extract(epoch FROM now())::float8 AS db_now
        FROM "tenant" WHERE "id" = ${tenant.id}::uuid`;

      expect(Math.abs(row.epoch * 1000 - before)).toBeLessThan(10_000);
      expect(Math.abs(row.epoch - row.db_now)).toBeLessThan(10);
    } finally {
      await prisma.$disconnect();
    }
  });
});
