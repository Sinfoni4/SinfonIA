import { describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeWorkflow } from '../src/core/workflow/practice.workflow.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { buildServer } from '../src/interface/http/server.js';
import { runtimeState } from '../src/runtime/runtime.state.js';
import { createLogger } from '../src/shared/logger.js';

import { TEST_AUTH_ENV } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

const stubLLM: LLMClient = { complete: () => Promise.reject(new Error('stub')) };

describe('system bootstrap', () => {
  it('loads configuration from environment', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: 'postgresql://example.invalid/db',
      SERVICE_NAME: 'sinfonia-test',
      ...TEST_AUTH_ENV,
    });

    expect(config.NODE_ENV).toBe('test');
    expect(config.SERVICE_NAME).toBe('sinfonia-test');
  });

  it('fails fast when AUTH_SECRET is missing or too short', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PORT: '3001',
        DATABASE_URL: 'postgresql://example.invalid/db',
        SERVICE_NAME: 'sinfonia-test',
      }),
    ).toThrow(/AUTH_SECRET/);
  });

  it('can start and stop the HTTP server', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3001',
      DATABASE_URL: 'postgresql://example.invalid/db',
      SERVICE_NAME: 'sinfonia-test',
      ...TEST_AUTH_ENV,
    });

    const logger = createLogger(config);
    const prisma = createPrismaClient(config.DATABASE_URL);
    const practiceWorkflow = new PracticeWorkflow(prisma);
    const interpreterService = new InterpreterService(stubLLM);
    const executorService = new ExecutorService({ practiceWorkflow });
    const contextService = new ContextService(prisma);
    const decisionEngine = new DecisionEngine();
    const normalizerService = new NormalizerService();
    const app = buildServer(config, logger, {
      practiceWorkflow,
      interpreterService,
      executorService,
      contextService,
      decisionEngine,
      normalizerService,
    });

    try {
      runtimeState.setDatabaseReachable(true);
      runtimeState.setMode('HEALTHY');
      await app.listen({ port: 0, host: '127.0.0.1' });

      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);

      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);

      runtimeState.setDatabaseReachable(false);
      const notReady = await app.inject({ method: 'GET', url: '/readyz' });
      expect(notReady.statusCode).toBe(503);
    } finally {
      runtimeState.setDatabaseReachable(false);
      runtimeState.setMode('DEGRADED');
      await app.close();
      await prisma.$disconnect();
    }
  });
});
