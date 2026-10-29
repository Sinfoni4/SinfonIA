import { describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { PracticeRepository } from '../src/data/repositories/practice.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

const stubLLM: LLMClient = { complete: () => Promise.reject(new Error('stub')) };

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

function assertHasSuccess(x: unknown): asserts x is { success: boolean } {
  if (typeof x !== 'object' || x === null || !('success' in x)) {
    throw new Error('Invalid JSON response');
  }
}

describe('interface http', () => {
  itWithDb('POST /practices/:id/transition succeeds for valid transition', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-test',
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
      const practiceRepo = new PracticeRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-http-ok' });
      const user = await userRepo.createUser(tenant.id, {
        email: 'u@http.local',
        role: 'OPERATOR',
      });
      const practice = await practiceRepo.createPractice(tenant.id, {
        userId: user.id,
        payload: {},
      });

      const res = await app.inject({
        method: 'POST',
        url: `/practices/${practice.id}/transition`,
        headers: authHeaders(tenant.id, user.id, 'OPERATOR'),
        payload: { nextState: 'VALIDATED' },
      });

      expect(res.statusCode).toBe(200);
      const json: unknown = res.json();
      assertHasSuccess(json);
      if (!json.success) throw new Error('Expected success response');
      expect((json as { data?: { status?: string } }).data?.status).toBe('VALIDATED');
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  itWithDb('POST /practices/:id/transition returns 400 on invalid transition', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-test',
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
      const practiceRepo = new PracticeRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-http-400' });
      const user = await userRepo.createUser(tenant.id, {
        email: 'u@http400.local',
        role: 'OPERATOR',
      });
      const practice = await practiceRepo.createPractice(tenant.id, {
        userId: user.id,
        payload: {},
      });

      const res = await app.inject({
        method: 'POST',
        url: `/practices/${practice.id}/transition`,
        headers: authHeaders(tenant.id, user.id, 'OPERATOR'),
        payload: { nextState: 'COMPLETED' }, // illegal from CREATED
      });

      expect(res.statusCode).toBe(400);
      const json: unknown = res.json();
      assertHasSuccess(json);
      if (json.success) throw new Error('Expected error response');
      expect((json as { error?: { code?: string } }).error?.code).toBe('INVALID_STATE_TRANSITION');
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  itWithDb('POST /practices/:id/transition returns 409 on concurrency conflict', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-test',
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
      const practiceRepo = new PracticeRepository(prisma);

      const tenant = await tenantRepo.createTenant({ name: 't-http-409' });
      const user = await userRepo.createUser(tenant.id, {
        email: 'u@http409.local',
        role: 'OPERATOR',
      });
      const practice = await practiceRepo.createPractice(tenant.id, {
        userId: user.id,
        payload: {},
      });

      const req1 = app.inject({
        method: 'POST',
        url: `/practices/${practice.id}/transition`,
        headers: authHeaders(tenant.id, user.id, 'OPERATOR'),
        payload: { nextState: 'VALIDATED' },
      });
      const req2 = app.inject({
        method: 'POST',
        url: `/practices/${practice.id}/transition`,
        headers: authHeaders(tenant.id, user.id, 'OPERATOR'),
        payload: { nextState: 'VALIDATED' },
      });

      const [r1, r2] = await Promise.all([req1, req2]);
      const statuses = [r1.statusCode, r2.statusCode];
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      const failure = statuses.find((status) => status !== 200);
      expect([400, 409]).toContain(failure);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
