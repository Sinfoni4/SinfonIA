/**
 * Guarantees that authorization cannot be bypassed by adding code: every HTTP route declares a
 * permission, no role check lives outside the authorization service, and no route with an id
 * opens an object of another tenant.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { PUBLIC_PATHS } from '../src/interface/http/auth/auth.hook.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';
import type { RouteOptions } from 'fastify';

const DATABASE_URL = process.env.DATABASE_URL;
const SRC = path.resolve(__dirname, '../src');
const AUTHZ_DIR = path.join(SRC, 'core', 'authz');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '3004',
    DATABASE_URL: DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
    SERVICE_NAME: 'sinfonia-authz-coverage',
    RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_AI_PER_MINUTE: '100000',
    RATE_LIMIT_TENANT_PER_MINUTE: '100000',
    ...TEST_AUTH_ENV,
  });
}

function build(prisma: PrismaClient, routes: RouteOptions[]): ReturnType<typeof buildServer> {
  const cfg = config();
  const practiceService = new PracticeApplicationService(prisma);
  const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
  const app = buildServer(cfg, createLogger(cfg), {
    principals: testPrincipals(prisma),
    prisma,
    practiceService,
    complianceService: new ComplianceService(prisma),
    interpreterService: new InterpreterService(llm),
    executorService: new ExecutorService({ practiceService }),
    contextService: new ContextService(practiceService),
    decisionEngine: new DecisionEngine(),
    normalizerService: new NormalizerService(),
  });
  // Route plugins are loaded at ready(), after this hook: every API route is collected.
  app.addHook('onRoute', (route) => {
    routes.push(route);
  });
  return app;
}

describe('authorization coverage', () => {
  it('keeps role checks inside the authorization service only', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(AUTHZ_DIR))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter(({ text }) =>
            /\brole\s*[!=]==|[!=]==\s*'(ADMIN|OPERATOR|MEMBER)'|AUTH_ROLES|requireRole\(/.test(
              text,
            ),
          ),
      )
      .map(({ file, line }) => `${path.relative(SRC, file)}:${line}`);
    expect(offenders).toEqual([]);
  });

  it('refuses to start a server with a route that declares no permission', async () => {
    const cfg = config();
    const practiceService = new PracticeApplicationService({} as PrismaClient);
    const app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(),
      practiceService,
      interpreterService: new InterpreterService({ complete: () => Promise.resolve('') }),
      executorService: new ExecutorService({ practiceService }),
      contextService: new ContextService(practiceService),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
    // Async plugin: the registration error surfaces when the server starts.
    void app.register(async (child) => {
      child.get('/unprotected', () => ({ ok: true }));
      await Promise.resolve();
    });
    await expect(app.ready()).rejects.toThrow('declares no permission');
    await app.close().catch(() => undefined);
  });
});

describe.runIf(Boolean(DATABASE_URL))('authorization coverage with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  const routes: RouteOptions[] = [];
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let ids: { practice: string; deadline: string };
  let other: { tenantId: string; adminId: string };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    const tenantA = await tenants.createTenant({ name: `authz-cov-a-${run}` });
    const tenantB = await tenants.createTenant({ name: `authz-cov-b-${run}` });
    const adminA = await users.createUser(tenantA.id, {
      email: `cov-a-${run}@authz.local`,
      role: 'ADMIN',
    });
    const adminB = await users.createUser(tenantB.id, {
      email: `cov-b-${run}@authz.local`,
      role: 'ADMIN',
    });
    const practice = await new PracticeApplicationService(prisma).createPractice({
      tenantId: tenantA.id,
      userId: adminA.id,
      name: `Pratica coverage ${run}`,
      kind: 'music',
    });
    const deadline = await new ComplianceService(prisma).createDeadline({
      tenantId: tenantA.id,
      createdBy: adminA.id,
      category: 'DURC',
      title: `DURC coverage ${run}`,
      dueDate: '2027-12-31',
    });
    ids = { practice: practice.id, deadline: deadline.id };
    other = { tenantId: tenantB.id, adminId: adminB.id };
    app = build(prisma, routes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('declares a permission on every non-public route', () => {
    const api = routes.filter((r) => !PUBLIC_PATHS.has(r.url));
    expect(api.length).toBeGreaterThanOrEqual(10);
    const missing = api
      .filter((r) => !r.config?.permission)
      .map((r) => `${String(r.method)} ${r.url}`);
    expect(missing).toEqual([]);
  });

  it('never opens an object of another tenant through a route with an id', async () => {
    const withId = routes.filter((r) => r.url.includes(':id') && r.method !== 'HEAD');
    expect(withId.map((r) => `${String(r.method)} ${r.url}`).sort()).toEqual([
      'GET /practices/:id',
      'GET /practices/:id/attachments',
      'GET /practices/:id/attachments/:attachmentId/download',
      'POST /compliance/deadlines/:id/close',
      'POST /practices/:id/attachments',
      'POST /practices/:id/transition',
    ]);
    const payloads: Record<string, unknown> = {
      '/practices/:id/transition': { nextState: 'VALIDATED' },
      '/practices/:id/attachments': {
        fileName: 'nota.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('fattura').toString('base64'),
      },
    };
    for (const route of withId) {
      const id = route.url.startsWith('/compliance') ? ids.deadline : ids.practice;
      const res = await app.inject({
        method: String(route.method) as 'GET' | 'POST',
        url: route.url.replace(':id', id).replace(':attachmentId', randomUUID()),
        headers: authHeaders(other.tenantId, other.adminId, 'ADMIN'),
        ...(route.method === 'POST' ? { payload: payloads[route.url] ?? {} } : {}),
      });
      expect([403, 404], `${String(route.method)} ${route.url}`).toContain(res.statusCode);
    }
  });
});
