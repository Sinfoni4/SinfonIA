import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createPrismaPrincipalResolver } from '../src/core/authz/authorization.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('principal resolver (C1)', () => {
  it('reads the current role, refuses users of another tenant and removed users', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    try {
      const run = randomUUID().slice(0, 8);
      const tenants = new TenantRepository(prisma);
      const users = new UserRepository(prisma);
      const a = await tenants.createTenant({ name: `resolver-a-${run}` });
      const b = await tenants.createTenant({ name: `resolver-b-${run}` });
      const user = await users.createUser(a.id, {
        email: `r-${run}@authz.local`,
        role: 'OPERATOR',
      });
      const resolve = createPrismaPrincipalResolver(prisma);
      const ask = (tenantId: string, userId = user.id) =>
        resolve({ tenantId, userId, tokenRole: 'ADMIN' });

      // The token says ADMIN, the database says OPERATOR.
      expect(await ask(a.id)).toEqual({ tenantId: a.id, userId: user.id, role: 'OPERATOR' });
      // A real user, but of another tenant.
      expect(await ask(b.id)).toBeNull();
      expect(await ask(a.id, randomUUID())).toBeNull();

      // No cache: a role change applies to the very next request.
      await prisma.user.update({ where: { id: user.id }, data: { role: 'MEMBER' } });
      expect((await ask(a.id))?.role).toBe('MEMBER');
      await prisma.user.delete({ where: { id: user.id } });
      expect(await ask(a.id)).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });
});
