import { describe, expect, it } from 'vitest';

import { ConcurrencyError } from '../src/core/errors/concurrency.errors.js';
import { InvalidStateTransitionError } from '../src/core/errors/workflow.errors.js';
import { PracticeWorkflow } from '../src/core/workflow/practice.workflow.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { AuditRepository } from '../src/data/repositories/audit.repository.js';
import { PracticeRepository } from '../src/data/repositories/practice.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

describe('practice workflow', () => {
  itWithDb('executes a valid transition and writes audit', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const practiceRepo = new PracticeRepository(prisma);
      const auditRepo = new AuditRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-workflow' });
      const user = await userRepo.createUser(tenant.id, { email: 'op@t.local', role: 'OPERATOR' });
      const practice = await practiceRepo.createPractice(tenant.id, {
        userId: user.id,
        payload: {},
      });

      const wf = new PracticeWorkflow(prisma);
      const updated = await wf.transitionPractice({
        tenantId: tenant.id,
        practiceId: practice.id,
        nextState: 'VALIDATED',
        userId: user.id,
      });

      expect(updated.status).toBe('VALIDATED');

      const audit = await auditRepo.listByTenant(tenant.id, { limit: 10 });
      expect(audit.some((e) => e.eventType === 'PRACTICE_STATE_CHANGED')).toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });

  itWithDb('rejects an invalid transition', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const practiceRepo = new PracticeRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-invalid' });
      const user = await userRepo.createUser(tenant.id, { email: 'm@t.local', role: 'MEMBER' });
      const practice = await practiceRepo.createPractice(tenant.id, {
        userId: user.id,
        payload: {},
      });

      const wf = new PracticeWorkflow(prisma);

      await expect(
        wf.transitionPractice({
          tenantId: tenant.id,
          practiceId: practice.id,
          nextState: 'COMPLETED', // illegal from CREATED
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    } finally {
      await prisma.$disconnect();
    }
  });

  itWithDb('enforces tenant isolation via repository scoping', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const practiceRepo = new PracticeRepository(prisma);

      const t1 = await tenantRepo.createTenant({ name: 't1' });
      const t2 = await tenantRepo.createTenant({ name: 't2' });
      const u1 = await userRepo.createUser(t1.id, { email: 'u@t1.local', role: 'OPERATOR' });
      const p1 = await practiceRepo.createPractice(t1.id, { userId: u1.id, payload: {} });

      const wf = new PracticeWorkflow(prisma);
      await expect(
        wf.transitionPractice({
          tenantId: t2.id,
          practiceId: p1.id,
          nextState: 'VALIDATED',
          userId: null,
        }),
      ).rejects.toBeInstanceOf(Error); // NotFoundError from Data layer
    } finally {
      await prisma.$disconnect();
    }
  });

  itWithDb('prevents concurrent transitions via optimistic locking', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const practiceRepo = new PracticeRepository(prisma);
      const auditRepo = new AuditRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-concurrency' });
      const user = await userRepo.createUser(tenant.id, { email: 'c@t.local', role: 'OPERATOR' });
      const practice = await practiceRepo.createPractice(tenant.id, {
        userId: user.id,
        payload: {},
      });

      const wf = new PracticeWorkflow(prisma);

      const p1 = wf.transitionPractice({
        tenantId: tenant.id,
        practiceId: practice.id,
        nextState: 'VALIDATED',
        userId: user.id,
      });
      const p2 = wf.transitionPractice({
        tenantId: tenant.id,
        practiceId: practice.id,
        nextState: 'VALIDATED',
        userId: user.id,
      });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      // Depending on scheduling, the second request either loses the optimistic
      // lock (ConcurrencyError) or observes the already-updated state.
      expect(
        rejected[0].reason instanceof ConcurrencyError ||
          rejected[0].reason instanceof InvalidStateTransitionError,
      ).toBe(true);

      // Only one successful transition => only one audit event.
      const audit = await auditRepo.listByTenant(tenant.id, { limit: 50 });
      const events = audit.filter((e) => e.eventType === 'PRACTICE_STATE_CHANGED');
      expect(events.length).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
