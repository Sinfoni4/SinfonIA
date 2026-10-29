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

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

describe('e2e ai execute', () => {
  itWithDb('POST /ai/execute: natural input → correct execution', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-e2e',
      ...TEST_AUTH_ENV,
    });
    const prisma = createPrismaClient(config.DATABASE_URL);
    await prisma.$connect();

    const tenantRepo = new TenantRepository(prisma);
    const userRepo = new UserRepository(prisma);
    const practiceRepo = new PracticeRepository(prisma);
    const tenant = await tenantRepo.createTenant({ name: 'e2e-tenant' });
    const user = await userRepo.createUser(tenant.id, {
      email: 'e2e@test.local',
      role: 'OPERATOR',
    });
    const practice = await practiceRepo.createPractice(tenant.id, { userId: user.id, payload: {} });

    const llm: LLMClient = {
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            action: 'transition_practice',
            filters: { practiceId: practice.id },
            nextState: 'VALIDATED',
          }),
        ),
    };
    const logger = createLogger(config);
    const practiceService = new PracticeApplicationService(prisma);
    const interpreterService = new InterpreterService(llm);
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
      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenant.id, user.id, 'OPERATOR'),
        payload: { input: 'porta la pratica a validato' },
      });

      expect(res.statusCode).toBe(200);
      const body: unknown = res.json();
      if (typeof body !== 'object' || body === null || !('success' in body)) {
        throw new Error('Invalid response body');
      }
      const b = body as { success: boolean; result?: { status?: string } };
      expect(b.success).toBe(true);
      if (b.success && b.result && typeof b.result === 'object' && 'status' in b.result) {
        expect(b.result.status).toBe('VALIDATED');
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  itWithDb('POST /ai/execute: interpretation error', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-e2e',
      ...TEST_AUTH_ENV,
    });
    const prisma = createPrismaClient(config.DATABASE_URL);
    await prisma.$connect();

    const llm: LLMClient = {
      complete: () => Promise.resolve(JSON.stringify({ error: 'AMBIGUOUS_INPUT' })),
    };
    const logger = createLogger(config);
    const practiceService = new PracticeApplicationService(prisma);
    const interpreterService = new InterpreterService(llm);
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
      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(
          '550e8400-e29b-41d4-a716-446655440001',
          '550e8400-e29b-41d4-a716-446655440002',
          'MEMBER',
        ),
        payload: { input: 'fai qualcosa' },
      });

      expect(res.statusCode).toBe(400);
      const body: unknown = res.json();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const err = (body as { error: { code?: string } }).error;
        expect(err?.code).toBe('INTERPRETER_ERROR');
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  itWithDb('POST /ai/execute: execution error (invalid transition)', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-e2e',
      ...TEST_AUTH_ENV,
    });
    const prisma = createPrismaClient(config.DATABASE_URL);
    await prisma.$connect();

    const tenantRepo = new TenantRepository(prisma);
    const userRepo = new UserRepository(prisma);
    const practiceRepo = new PracticeRepository(prisma);
    const tenant = await tenantRepo.createTenant({ name: 'e2e-err' });
    const user = await userRepo.createUser(tenant.id, {
      email: 'e2e-err@test.local',
      role: 'MEMBER',
    });
    const practice = await practiceRepo.createPractice(tenant.id, { userId: user.id, payload: {} });

    // LLM returns valid JSON but transition CREATED → COMPLETED is invalid
    const llm: LLMClient = {
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            action: 'transition_practice',
            filters: { practiceId: practice.id },
            nextState: 'COMPLETED',
          }),
        ),
    };
    const logger = createLogger(config);
    const practiceService = new PracticeApplicationService(prisma);
    const interpreterService = new InterpreterService(llm);
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
      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenant.id, user.id, 'OPERATOR'),
        payload: { input: 'completa la pratica' },
      });

      expect(res.statusCode).toBe(400);
      const body: unknown = res.json();
      if (typeof body !== 'object' || body === null || !('success' in body)) {
        throw new Error('Invalid response body');
      }
      const b = body as { success: boolean; error?: { code?: string } };
      expect(b.success).toBe(false);
      expect(b.error?.code).toBe('VALIDATION_ERROR');
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
