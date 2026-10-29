import { describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { parsePracticeCommand } from '../src/core/practice/practice.commands.js';
import { SchedulerService } from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

const stubLLM: LLMClient = { complete: () => Promise.reject(new Error('stub')) };

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

describe('Phase 2 Gate: Verification and Resilience', () => {
  // -------------------------------------------------------------
  // Gate 1: Riavvio senza perdita dati e zero burst all'avvio
  // -------------------------------------------------------------
  itWithDb(
    'Gate 1: Restart preserves data integrity and prevents export burst on boot',
    async () => {
      const prisma = createPrismaClient(DATABASE_URL!);
      await prisma.$connect();

      try {
        const tenantRepo = new TenantRepository(prisma);
        const userRepo = new UserRepository(prisma);

        const tenant = await tenantRepo.createTenant({
          name: 'gate-restart-tenant',
          schedulerEnabled: true,
          schedulerFrequency: 'monthly',
        });

        const admin = await userRepo.createUser(tenant.id, {
          email: 'admin@gate-restart.local',
          role: 'ADMIN',
        });

        // 1. First lifecycle: Create practice and run scheduler
        let serviceA: PracticeApplicationService | null = new PracticeApplicationService(prisma);
        const practice = await serviceA.createPractice({
          tenantId: tenant.id,
          userId: admin.id,
          name: 'Pratica Pre-Restart',
          kind: 'music',
          metadata: { album: 'Resilience 2026' },
        });

        let schedulerA: SchedulerService | null = new SchedulerService(prisma, serviceA);
        const fixedNow = new Date('2026-10-26T12:00:00Z');

        const initialTick = await schedulerA.tick(fixedNow, tenant.id);
        // The export plus the daily compliance check every tenant gets.
        expect(initialTick.triggeredCount).toBe(2);

        // 2. Simulate complete service shutdown / reboot
        serviceA = null;
        schedulerA = null;

        // 3. New service instances after reboot
        const serviceB = new PracticeApplicationService(prisma);
        const schedulerB = new SchedulerService(prisma, serviceB);

        // Verify data intact after reboot
        const retrievedPractice = await serviceB.getPractice({
          tenantId: tenant.id,
          practiceId: practice.id,
        });
        expect(retrievedPractice.id).toBe(practice.id);
        expect(retrievedPractice.name).toBe('Pratica Pre-Restart');
        expect(retrievedPractice.schemaVersion).toBe(1);

        // Verify ZERO burst on boot (durable scheduler skips because run is already persisted)
        const rebootTick = await schedulerB.tick(fixedNow, tenant.id);
        expect(rebootTick.triggeredCount).toBe(0);
        expect(rebootTick.skippedCount).toBe(2);

        const runs = await prisma.schedulerRun.findMany({ where: { tenantId: tenant.id } });
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.status === 'COMPLETED')).toBe(true);
      } finally {
        await prisma.$disconnect();
      }
    },
  );

  // -------------------------------------------------------------
  // Gate 2: Doppio worker senza export duplicati (Advisory Lock)
  // -------------------------------------------------------------
  itWithDb(
    'Gate 2: Dual concurrent workers produce zero duplicate exports (Advisory Lock)',
    async () => {
      const prisma1 = createPrismaClient(DATABASE_URL!);
      const prisma2 = createPrismaClient(DATABASE_URL!);
      await prisma1.$connect();
      await prisma2.$connect();

      try {
        const tenantRepo = new TenantRepository(prisma1);
        const userRepo = new UserRepository(prisma1);

        const tenant = await tenantRepo.createTenant({
          name: 'gate-dual-worker-tenant',
          schedulerEnabled: true,
          schedulerFrequency: 'daily',
        });

        await userRepo.createUser(tenant.id, {
          email: 'admin@gate-dual.local',
          role: 'ADMIN',
        });

        let totalExportCalls = 0;
        const mockPracticeService: Pick<PracticeApplicationService, 'exportPractices'> = {
          exportPractices: async () => {
            await Promise.resolve();
            totalExportCalls++;
            return {
              filter: { type: 'today' },
              title: 'Export Pratiche Dual Worker',
              csv: 'Nome,Data Creazione\nDualWorkerTest,2026-10-26T00:00:00Z\n',
              count: 0,
            };
          },
        };

        const worker1 = new SchedulerService(prisma1, mockPracticeService);
        const worker2 = new SchedulerService(prisma2, mockPracticeService);

        const now = new Date('2026-10-26T14:00:00Z');

        // Both workers attempt to execute simultaneously
        const [res1, res2] = await Promise.all([
          worker1.tick(now, tenant.id),
          worker2.tick(now, tenant.id),
        ]);

        const totalTriggered = res1.triggeredCount + res2.triggeredCount;
        // Exactly one worker runs each task (export and compliance check).
        expect(totalTriggered).toBe(2);
        expect(totalExportCalls).toBe(1); // Zero duplicate exports

        // Verify outbox contains exactly 1 message
        const outboxMessages = await prisma1.outboxMessage.findMany({
          where: { tenantId: tenant.id },
        });
        expect(outboxMessages).toHaveLength(1);
        expect(outboxMessages[0]?.eventType).toBe('PRACTICE_EXPORT_GENERATED');
      } finally {
        await prisma1.$disconnect();
        await prisma2.$disconnect();
      }
    },
  );

  // -------------------------------------------------------------
  // Gate 3: Equivalenza Funzionale HTTP vs Telegram
  // -------------------------------------------------------------
  itWithDb('Gate 3: Functional equivalence between HTTP and Telegram', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3003',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-gate-parity-test',
      ...TEST_AUTH_ENV,
    });

    const prisma = createPrismaClient(config.DATABASE_URL);
    await prisma.$connect();

    const logger = createLogger(config);
    const practiceService = new PracticeApplicationService(prisma);
    const interpreterService = new InterpreterService(stubLLM);
    const executorService = new ExecutorService({ practiceService });
    const contextService = new ContextService(practiceService);
    const decisionEngine = new DecisionEngine();
    const normalizerService = new NormalizerService();
    const app = buildServer(config, logger, {
      principals: testPrincipals(),
      practiceService,
      interpreterService,
      executorService,
      contextService,
      decisionEngine,
      normalizerService,
    });

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 'gate-parity-tenant' });
      const user = await userRepo.createUser(tenant.id, {
        email: 'user@gate-parity.local',
        role: 'ADMIN',
      });

      // 1. Create practice via HTTP
      const httpCreateRes = await app.inject({
        method: 'POST',
        url: '/practices',
        headers: authHeaders(tenant.id, user.id, 'ADMIN'),
        payload: { name: 'Pratica Parity HTTP', kind: 'music' },
      });
      expect(httpCreateRes.statusCode).toBe(201);
      const httpPractice = httpCreateRes.json<{
        success: boolean;
        data: { id: string; name: string; kind: string; schemaVersion: number; status: string };
      }>();

      // 2. Create practice via Telegram deterministic command
      const tgCommand = parsePracticeCommand('crea pratica Pratica Parity TG');
      expect(tgCommand).not.toBeNull();
      const tgResult = await practiceService.executeCommand(tgCommand!, {
        tenantId: tenant.id,
        userId: user.id,
        role: user.role,
      });
      expect(tgResult.type).toBe('created');
      const tgPractice = (
        tgResult as {
          type: 'created';
          practice: { name: string; schemaVersion: number; status: string };
        }
      ).practice;

      // Assert model equivalence
      expect(httpPractice.data.schemaVersion).toBe(tgPractice.schemaVersion);
      expect(httpPractice.data.status).toBe(tgPractice.status);
      expect(tgPractice.status).toBe('CREATED');

      // 3. Status check equivalence
      const httpStatusRes = await app.inject({
        method: 'GET',
        url: `/practices/${httpPractice.data.id}`,
        headers: authHeaders(tenant.id, user.id, 'ADMIN'),
      });
      expect(httpStatusRes.statusCode).toBe(200);

      const tgStatusCmd = parsePracticeCommand('stato pratica Pratica Parity HTTP');
      const tgStatusResult = await practiceService.executeCommand(tgStatusCmd!, {
        tenantId: tenant.id,
        userId: user.id,
        role: user.role,
      });
      expect(tgStatusResult.type).toBe('status');
      if (tgStatusResult.type === 'status') {
        expect(tgStatusResult.practice.id).toBe(httpPractice.data.id);
      }

      // 4. Export equivalence
      const httpExportRes = await app.inject({
        method: 'POST',
        url: '/practices/export',
        headers: authHeaders(tenant.id, user.id, 'ADMIN'),
        payload: { filter: { type: 'today' } },
      });
      expect(httpExportRes.statusCode).toBe(200);
      const httpExportJson = httpExportRes.json<{ success: boolean; data: { csv: string } }>();

      const tgExportCmd = parsePracticeCommand('export pratiche mese');
      const tgExportResult = await practiceService.executeCommand(tgExportCmd!, {
        tenantId: tenant.id,
        userId: user.id,
        role: user.role,
      });
      expect(tgExportResult.type).toBe('export');
      if (tgExportResult.type === 'export') {
        expect(httpExportJson.data.csv).toContain('Pratica Parity HTTP');
        expect(tgExportResult.result.csv).toContain('Pratica Parity HTTP');
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  // -------------------------------------------------------------
  // Gate 4: EXPLAIN Plan sulle Query Principali
  // -------------------------------------------------------------
  itWithDb('Gate 4: Verifies EXPLAIN query plans on primary indexes', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();

    try {
      type ExplainRow = { 'QUERY PLAN': string };

      // Ensure PostgreSQL uses index scans even when row counts are minimal in test fixtures
      await prisma.$executeRawUnsafe('SET enable_seqscan = off');

      // Query 1: Tenant + Status Index
      const plan1 = await prisma.$queryRawUnsafe<ExplainRow[]>(
        `EXPLAIN SELECT * FROM "practice" WHERE "tenant_id" = '00000000-0000-0000-0000-000000000000' AND "status" = 'CREATED' ORDER BY "created_at" DESC`,
      );
      expect(plan1.length).toBeGreaterThan(0);
      const planText1 = plan1.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText1.toLowerCase()).toContain('index');

      // Query 2: JSON Payload Search (GIN index eligibility)
      const plan2 = await prisma.$queryRawUnsafe<ExplainRow[]>(
        `EXPLAIN SELECT * FROM "practice" WHERE "tenant_id" = '00000000-0000-0000-0000-000000000000' AND "payload" @> '{"type": "music_practice"}'`,
      );
      expect(plan2.length).toBeGreaterThan(0);
      const planText2 = plan2.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText2.toLowerCase()).toContain('index');

      // Query 3: Scheduler Run Idempotency Key
      const plan3 = await prisma.$queryRawUnsafe<ExplainRow[]>(
        `EXPLAIN SELECT * FROM "scheduler_run" WHERE "idempotency_key" = 'tenant:task:frequency:period'`,
      );
      expect(plan3.length).toBeGreaterThan(0);
      const planText3 = plan3.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText3.toLowerCase()).toContain('index scan');
    } finally {
      await prisma.$disconnect();
    }
  });
});
