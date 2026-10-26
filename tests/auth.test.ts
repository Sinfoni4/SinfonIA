import { describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeWorkflow } from '../src/core/workflow/practice.workflow.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { PracticeRepository } from '../src/data/repositories/practice.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { AuthError } from '../src/interface/http/auth/auth.errors.js';
import { AuthService } from '../src/interface/http/auth/auth.service.js';
import { issueAuthToken, verifyAuthToken } from '../src/interface/http/auth/token.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_CONFIG, TEST_AUTH_ENV } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

const stubLLM: LLMClient = { complete: () => Promise.reject(new Error('stub')) };
const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440010';
const USER_ID = '550e8400-e29b-41d4-a716-446655440011';

function buildTestApp(prisma: ReturnType<typeof createPrismaClient>, llm: LLMClient = stubLLM) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '3001',
    DATABASE_URL: DATABASE_URL!,
    SERVICE_NAME: 'sinfonia-auth-test',
    ...TEST_AUTH_ENV,
  });
  const logger = createLogger(config);
  const practiceWorkflow = new PracticeWorkflow(prisma);

  return buildServer(config, logger, {
    practiceWorkflow,
    interpreterService: new InterpreterService(llm),
    executorService: new ExecutorService({ practiceWorkflow }),
    contextService: new ContextService(prisma),
    decisionEngine: new DecisionEngine(),
    normalizerService: new NormalizerService(),
  });
}

describe('auth tokens', () => {
  it('issues and verifies HS256 bearer tokens', () => {
    const token = issueAuthToken(
      { tenantId: TENANT_ID, userId: USER_ID, role: 'ADMIN' },
      TEST_AUTH_CONFIG,
    );

    const claims = verifyAuthToken(token, TEST_AUTH_CONFIG);
    expect(claims).toMatchObject({
      sub: USER_ID,
      tid: TENANT_ID,
      role: 'ADMIN',
      iss: TEST_AUTH_CONFIG.issuer,
      aud: TEST_AUTH_CONFIG.audience,
    });
  });

  it('rejects tampered tokens', () => {
    const token = issueAuthToken(
      { tenantId: TENANT_ID, userId: USER_ID, role: 'ADMIN' },
      TEST_AUTH_CONFIG,
    );
    const parts = token.split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    const tampered = parts.join('.');

    expect(() => verifyAuthToken(tampered, TEST_AUTH_CONFIG)).toThrow(AuthError);
  });

  it('rejects expired tokens', () => {
    const token = issueAuthToken(
      { tenantId: TENANT_ID, userId: USER_ID, role: 'MEMBER', ttlSeconds: 60 },
      TEST_AUTH_CONFIG,
      1_000,
    );

    expect(() => verifyAuthToken(token, TEST_AUTH_CONFIG, 2_000)).toThrow(/expired/i);
  });

  it('requires the bearer scheme', () => {
    const auth = new AuthService(TEST_AUTH_CONFIG);
    expect(() => auth.authenticate(undefined)).toThrow(/Missing Authorization/i);
    expect(() => auth.authenticate(`Basic ${TENANT_ID}`)).toThrow(/Bearer/i);
  });
});

describe('auth http', () => {
  itWithDb('health is public while business routes require authentication', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const app = buildTestApp(prisma);

    try {
      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);

      const whoami = await app.inject({ method: 'GET', url: '/auth/whoami' });
      expect(whoami.statusCode).toBe(401);
      expect(whoami.json()).toMatchObject({ success: false, error: { code: 'MISSING_TOKEN' } });

      const invalid = await app.inject({
        method: 'GET',
        url: '/auth/whoami',
        headers: { authorization: 'Bearer not-a-valid-token' },
      });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.json()).toMatchObject({ success: false, error: { code: 'INVALID_TOKEN' } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  itWithDb('enforces roles and authoritative token tenant', async () => {
    const prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const app = buildTestApp(prisma);

    try {
      const tenantRepo = new TenantRepository(prisma);
      const userRepo = new UserRepository(prisma);
      const practiceRepo = new PracticeRepository(prisma);

      const tenantA = await tenantRepo.createTenant({ name: 'auth-tenant-a' });
      const tenantB = await tenantRepo.createTenant({ name: 'auth-tenant-b' });
      const userA = await userRepo.createUser(tenantA.id, {
        email: 'auth-a@test.local',
        role: 'OPERATOR',
      });
      const userB = await userRepo.createUser(tenantB.id, {
        email: 'auth-b@test.local',
        role: 'OPERATOR',
      });
      const practiceA = await practiceRepo.createPractice(tenantA.id, {
        userId: userA.id,
        payload: {},
      });

      const whoami = await app.inject({
        method: 'GET',
        url: '/auth/whoami',
        headers: authHeaders(tenantA.id, userA.id, 'ADMIN'),
      });
      expect(whoami.statusCode).toBe(200);
      expect(whoami.json()).toMatchObject({
        subject: userA.id,
        tenantId: tenantA.id,
        role: 'ADMIN',
      });

      const member = await app.inject({
        method: 'POST',
        url: `/practices/${practiceA.id}/transition`,
        headers: authHeaders(tenantA.id, userA.id, 'MEMBER'),
        payload: { nextState: 'VALIDATED' },
      });
      expect(member.statusCode).toBe(403);

      const crossTenant = await app.inject({
        method: 'POST',
        url: `/practices/${practiceA.id}/transition`,
        headers: authHeaders(tenantB.id, userB.id, 'ADMIN'),
        payload: { nextState: 'VALIDATED' },
      });
      expect(crossTenant.statusCode).toBe(404);

      const spoofedHeader = await app.inject({
        method: 'POST',
        url: `/practices/${practiceA.id}/transition`,
        headers: {
          ...authHeaders(tenantA.id, userA.id, 'OPERATOR'),
          'x-tenant-id': tenantB.id,
          'x-user-id': userB.id,
        },
        payload: { nextState: 'VALIDATED' },
      });
      expect(spoofedHeader.statusCode).toBe(200);
      expect(spoofedHeader.json()).toMatchObject({
        success: true,
        data: { id: practiceA.id, tenantId: tenantA.id },
      });

      let aiPracticeId = '';
      const transitionLLM: LLMClient = {
        complete: () =>
          Promise.resolve(
            JSON.stringify({
              action: 'transition_practice',
              filters: { practiceId: aiPracticeId, status: null, name: null },
              artistName: null,
              nextState: 'VALIDATED',
            }),
          ),
      };
      const aiApp = buildTestApp(prisma, transitionLLM);
      try {
        const practiceForAi = await practiceRepo.createPractice(tenantA.id, {
          userId: userA.id,
          payload: {},
        });
        aiPracticeId = practiceForAi.id;

        const memberAiTransition = await aiApp.inject({
          method: 'POST',
          url: '/ai/execute',
          headers: authHeaders(tenantA.id, userA.id, 'MEMBER'),
          payload: { input: `valida la pratica ${practiceForAi.id}` },
        });
        expect(memberAiTransition.statusCode).toBe(403);

        const operatorAiTransition = await aiApp.inject({
          method: 'POST',
          url: '/ai/execute',
          headers: authHeaders(tenantA.id, userA.id, 'OPERATOR'),
          payload: { input: `valida la pratica ${practiceForAi.id}` },
        });
        expect(operatorAiTransition.statusCode).toBe(200);
        expect(operatorAiTransition.json()).toMatchObject({
          success: true,
          result: { id: practiceForAi.id, tenantId: tenantA.id, status: 'VALIDATED' },
        });
      } finally {
        await aiApp.close();
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
