import { describe, expect, it } from 'vitest';

import { bindUserToTenant, getTenantIdByInvite } from '../src/core/tenant/tenant.invite.store.js';
import { provisionTenant } from '../src/core/tenant/tenant.provisioning.js';
import { getTenantByTelegramUserAsync } from '../src/core/tenant/tenant.store.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { NotFoundError } from '../src/data/errors/errors.js';
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

      const u2 = await userRepo.createUser(t2.id, {
        email: 'u2b@tenant2.local',
        role: 'MEMBER',
      });

      await expect(
        practiceRepo.createPractice(t1.id, { userId: u2.id, payload: {} }),
      ).rejects.toBeInstanceOf(NotFoundError);

      await expect(
        audit.logEvent({
          tenantId: t1.id,
          userId: u2.id,
          eventType: 'cross.tenant',
          payload: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Defense in depth: the database trigger rejects direct bypass attempts.
      await expect(
        prisma.practice.create({
          data: { tenantId: t1.id, userId: u2.id, payload: {} },
        }),
      ).rejects.toThrow();

      const telegramUser = await userRepo.ensureTelegramUser(t1.id, '123456');
      const telegramUserAgain = await userRepo.ensureTelegramUser(t1.id, '123456');
      expect(telegramUser.id).toBe(telegramUserAgain.id);
      expect(telegramUser.telegramId).toBe('123456');

      const identity = await getTenantByTelegramUserAsync(prisma, '123456');
      expect(identity.tenant.id).toBe(t1.id);
      expect(identity.userId).toBe(telegramUser.id);
      expect(identity.role).toBe('MEMBER');

      await expect(bindUserToTenant(prisma, u2.id, t1.id)).rejects.toBeInstanceOf(NotFoundError);

      const provisioned = await provisionTenant(prisma, {
        name: 'provisioned-test',
        adminEmail: 'provisioned-admin@test.local',
        adminTelegramId: '987654321',
      });
      expect(await getTenantIdByInvite(prisma, provisioned.inviteCode)).toBe(provisioned.tenantId);
      const provisionedAdmin = await userRepo.getUserById(
        provisioned.tenantId,
        provisioned.adminUserId,
      );
      expect(provisionedAdmin.role).toBe('ADMIN');
      expect(provisionedAdmin.telegramId).toBe('987654321');
      const provisionedIdentity = await getTenantByTelegramUserAsync(prisma, '987654321');
      expect(provisionedIdentity.tenant.id).toBe(provisioned.tenantId);
      expect(provisionedIdentity.role).toBe('ADMIN');
      const binding = await prisma.userTenant.findFirst({
        where: {
          userId: provisioned.adminUserId,
          tenantId: provisioned.tenantId,
        },
      });
      expect(binding).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });
});
