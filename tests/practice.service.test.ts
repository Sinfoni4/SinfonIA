import { describe, expect, it } from 'vitest';

import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { AuditRepository } from '../src/data/repositories/audit.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

describe('practice application service', () => {
  itWithDb('creates canonical practices only for a persisted tenant user', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const auditRepo = new AuditRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-service-create' });
      const otherTenant = await tenantRepo.createTenant({ name: 't-service-other' });
      const user = await userRepo.createUser(tenant.id, {
        email: 'service@test.local',
        role: 'MEMBER',
      });
      const otherUser = await userRepo.createUser(otherTenant.id, {
        email: 'other-service@test.local',
        role: 'MEMBER',
      });

      const service = new PracticeApplicationService(prisma);
      const created = await service.createPractice({
        tenantId: tenant.id,
        userId: user.id,
        name: 'Concerto di prova',
        kind: 'music',
      });

      expect(created.name).toBe('Concerto di prova');
      expect(created.kind).toBe('music');
      expect(created.status).toBe('CREATED');

      const stored = await prisma.practice.findFirst({ where: { id: created.id } });
      expect(stored?.payload).toMatchObject({
        type: 'music_practice',
        name: 'Concerto di prova',
      });

      const audit = await auditRepo.listByTenant(tenant.id, { limit: 10 });
      expect(audit.some((event) => event.eventType === 'PRACTICE_CREATED')).toBe(true);

      await expect(
        service.createPractice({
          tenantId: tenant.id,
          userId: otherUser.id,
          name: 'Cross tenant',
          kind: 'music',
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$disconnect();
    }
  });

  itWithDb('executes deterministic commands through the canonical service', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const tenant = await tenantRepo.createTenant({ name: 't-service-commands' });
      const user = await userRepo.createUser(tenant.id, {
        email: 'commands@test.local',
        role: 'OPERATOR',
      });
      const actor = { tenantId: tenant.id, userId: user.id };
      const service = new PracticeApplicationService(prisma);

      const created = await service.executeCommand(
        { type: 'CREATE_PRACTICE', payload: { name: 'Serata live' } },
        actor,
      );
      expect(created.type).toBe('created');

      const listed = await service.executeCommand({ type: 'LIST_PRACTICES', payload: {} }, actor);
      expect(listed.type).toBe('list');
      if (listed.type === 'list') {
        expect(listed.practices.some((practice) => practice.name === 'Serata live')).toBe(true);
      }

      const status = await service.executeCommand(
        { type: 'GET_PRACTICE_STATUS', payload: { name: 'Serata live' } },
        actor,
      );
      expect(status.type).toBe('status');
      if (status.type === 'status') {
        expect(status.practice.status).toBe('CREATED');
      }

      const exported = await service.exportPractices({
        tenantId: tenant.id,
        userId: user.id,
        filter: { type: 'today' },
      });
      expect(exported.count).toBeGreaterThanOrEqual(1);
      expect(exported.csv).toContain('Serata live');

      const deleted = await service.executeCommand(
        { type: 'DELETE_PRACTICE', payload: { name: 'Serata live' } },
        actor,
      );
      expect(deleted.type).toBe('deleted');

      const missing = await service.executeCommand(
        { type: 'GET_PRACTICE_STATUS', payload: { name: 'Serata live' } },
        actor,
      );
      expect(missing.type).toBe('not_found');
    } finally {
      await prisma.$disconnect();
    }
  });
});
