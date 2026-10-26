import { describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/data/db/prisma.js';
import { PracticeRepository } from '../src/data/repositories/practice.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { AuditService } from '../src/data/services/audit.service.js';

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

describe('data layer (postgres)', () => {
  itWithDb('creates tenant, user, practice and enforces tenant isolation', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const practiceRepo = new PracticeRepository(prisma);
      const audit = new AuditService(prisma);

      const t1 = await tenantRepo.createTenant({ name: 'tenant-1' });
      const t2 = await tenantRepo.createTenant({ name: 'tenant-2' });

      const u1 = await userRepo.createUser(t1.id, { email: 'u1@tenant1.local', role: 'ADMIN' });
      await userRepo.createUser(t2.id, { email: 'u2@tenant2.local', role: 'MEMBER' });

      const p1 = await practiceRepo.createPractice(t1.id, {
        userId: u1.id,
        payload: { hello: 'world' },
      });

      await audit.logEvent({
        tenantId: t1.id,
        userId: u1.id,
        eventType: 'practice.created',
        payload: { practiceId: p1.id },
      });

      const t1Practices = await practiceRepo.listPractices(t1.id);
      const t2Practices = await practiceRepo.listPractices(t2.id);

      expect(t1Practices.some((p) => p.id === p1.id)).toBe(true);
      expect(t2Practices.some((p) => p.id === p1.id)).toBe(false);
      expect(t2Practices.length).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
