import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/data/db/prisma.js';
import {
  PracticeRepository,
  type PracticeListFilter,
} from '../src/data/repositories/practice.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { Prisma, PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

/** The query used before the single-query version: the reference the results must match. */
async function reference(prisma: PrismaClient, tenantId: string, filter: PracticeListFilter) {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const search = filter.search?.trim();
  const isUuid =
    Boolean(search) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search!);
  const byName = {
    payload: { path: ['name'], string_contains: search, mode: 'insensitive' as const },
  };
  const where: Prisma.PracticeWhereInput = {
    tenantId,
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(search ? (isUuid ? { OR: [{ id: search }, byName] } : byName) : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.practice.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [filter.sortBy ?? 'createdAt']: filter.sortOrder ?? 'desc' },
    }),
    prisma.practice.count({ where }),
  ]);
  return { ids: rows.map((r) => r.id), total };
}

describe.runIf(Boolean(DATABASE_URL))('paginated practices in one query', () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let users: string[];
  let ids: string[];

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const run = randomUUID().slice(0, 8);
    tenantId = (await new TenantRepository(prisma).createTenant({ name: `pag-${run}` })).id;
    const userRepo = new UserRepository(prisma);
    users = [
      (await userRepo.createUser(tenantId, { email: `pag-a-${run}@t.local`, role: 'ADMIN' })).id,
      (await userRepo.createUser(tenantId, { email: `pag-b-${run}@t.local`, role: 'MEMBER' })).id,
    ];
    const repo = new PracticeRepository(prisma);
    const names = ['Alfa', 'alfa beta', 'ALFA gamma', '100% bio', 'a_b', 'axb', 'Zeta', 'zeta 2'];
    ids = [];
    for (const [i, name] of names.entries()) {
      const p = await repo.createPractice(tenantId, {
        userId: users[i % 2],
        status: i % 3 === 0 ? 'VALIDATED' : 'CREATED',
        payload: { schemaVersion: 1, type: 'music_practice', name },
      });
      ids.push(p.id);
    }
    // Distinct update times in reverse order, to tell the two sort fields apart.
    for (const [i, id] of [...ids].reverse().entries()) {
      await prisma.practice.update({ where: { id }, data: { version: { increment: i } } });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('returns the same rows and totals as the previous two queries', async () => {
    const repo = new PracticeRepository(prisma);
    const filters: PracticeListFilter[] = [
      {},
      { limit: 3 },
      { limit: 3, page: 2 },
      { limit: 3, page: 3 },
      { limit: 3, page: 9 },
      { userId: users[1] },
      { status: 'VALIDATED' },
      { search: 'alfa' },
      { search: 'ALFA', limit: 2, page: 2 },
      { search: '%' },
      { search: '_' },
      { search: 'a_b' },
      { search: 'nessuna' },
      { search: ids[3] },
      { sortBy: 'updatedAt', sortOrder: 'asc' },
      { sortBy: 'createdAt', sortOrder: 'asc', limit: 4, page: 2 },
      { userId: users[0], status: 'CREATED', search: 'a' },
    ];
    for (const filter of filters) {
      const actual = await repo.findPracticesPaginated(tenantId, filter);
      const expected = await reference(prisma, tenantId, filter);
      expect(
        { ids: actual.items.map((p) => p.id), total: actual.total },
        JSON.stringify(filter),
      ).toEqual(expected);
    }
  });
});
