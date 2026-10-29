import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { AITracer, type AITraceRecord } from '../src/ai/tracing/ai.tracer.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { AiTraceRepository } from '../src/data/repositories/ai-trace.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

function trace(tenantId: string, overrides: Partial<AITraceRecord> = {}): AITraceRecord {
  return {
    requestId: randomUUID(),
    tenantId,
    userId: randomUUID(),
    model: 'gpt-4o-mini',
    provider: 'openai',
    latencyMs: 120,
    outcome: 'SUCCESS',
    action: 'create_practice',
    tokens: { promptTokens: 400, completionTokens: 60, totalTokens: 460 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('AI context limits', () => {
  it('applies the context limit in the database query, not in memory', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { practice: { findMany } } as unknown as PrismaClient;
    const context = new ContextService(new PracticeApplicationService(prisma));

    await context.getRelevantPracticeContext(randomUUID(), 'valida la pratica', null, 20);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
  });
});

describeWithDb('persistent AI traces (Step 3)', () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    tenantId = (await tenants.createTenant({ name: `t-traces-${randomUUID()}` })).id;
    otherTenantId = (await tenants.createTenant({ name: `t-traces-other-${randomUUID()}` })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps traces across a restart', async () => {
    const before = new AITracer(200, { store: new AiTraceRepository(prisma) });
    const recorded = before.record(trace(tenantId));
    await before.flush();

    // A new process: a new client and a new tracer with an empty memory buffer.
    const prisma2 = createPrismaClient(DATABASE_URL!);
    try {
      const after = new AITracer(200, { store: new AiTraceRepository(prisma2) });
      expect(after.getTraces()).toHaveLength(0);
      const { items } = await after.queryTraces({ tenantId, page: 1, limit: 100 });
      expect(items.map((t) => t.requestId)).toContain(recorded.requestId);
      expect(items.find((t) => t.requestId === recorded.requestId)?.tokens).toEqual({
        promptTokens: 400,
        completionTokens: 60,
        totalTokens: 460,
      });
    } finally {
      await prisma2.$disconnect();
    }
  });

  it('filters by outcome and time range, pages most recent first, per tenant', async () => {
    const tenant = (
      await new TenantRepository(prisma).createTenant({ name: `t-traces-f-${randomUUID()}` })
    ).id;
    const repo = new AiTraceRepository(prisma);
    const at = (iso: string) => new Date(iso).toISOString();
    await repo.save(trace(tenant, { outcome: 'SUCCESS', timestamp: at('2026-10-01T10:00:00Z') }));
    await repo.save(
      trace(tenant, { outcome: 'SECURITY_REJECTED', timestamp: at('2026-10-02T10:00:00Z') }),
    );
    await repo.save(trace(tenant, { outcome: 'SUCCESS', timestamp: at('2026-10-03T10:00:00Z') }));
    await repo.save(trace(tenant, { outcome: 'ERROR', timestamp: at('2026-10-04T10:00:00Z') }));
    await repo.save(
      trace(otherTenantId, { outcome: 'SUCCESS', timestamp: at('2026-10-03T10:00:00Z') }),
    );

    const success = await repo.query({ tenantId: tenant, outcome: 'SUCCESS', page: 1, limit: 10 });
    expect(success.total).toBe(2);
    expect(success.items.map((t) => t.timestamp)).toEqual([
      at('2026-10-03T10:00:00Z'),
      at('2026-10-01T10:00:00Z'),
    ]);

    const range = await repo.query({
      tenantId: tenant,
      from: new Date('2026-10-02T00:00:00Z'),
      to: new Date('2026-10-03T23:59:59Z'),
      page: 1,
      limit: 10,
    });
    expect(range.items.map((t) => t.outcome)).toEqual(['SUCCESS', 'SECURITY_REJECTED']);

    const page2 = await repo.query({ tenantId: tenant, page: 2, limit: 3 });
    expect(page2.total).toBe(4);
    expect(page2.items.map((t) => t.outcome)).toEqual(['SUCCESS']);
  });

  it('stores errors redacted and never any prompt text', async () => {
    const repo = new AiTraceRepository(prisma);
    const recorded = trace(tenantId, {
      outcome: 'ERROR',
      error: 'Invalid output for RSSMRA85M01H501Z, contact mario@example.com',
    });
    await repo.save(recorded);
    const row = await prisma.aiTrace.findFirstOrThrow({ where: { requestId: recorded.requestId } });
    expect(row.error).not.toContain('RSSMRA85M01H501Z');
    expect(row.error).not.toContain('mario@example.com');
    expect(Object.keys(row)).not.toContain('prompt');
  });

  it('deletes traces older than the retention period only', async () => {
    const tenant = (
      await new TenantRepository(prisma).createTenant({ name: `t-traces-r-${randomUUID()}` })
    ).id;
    const repo = new AiTraceRepository(prisma);
    await repo.save(trace(tenant, { timestamp: new Date('2020-01-01T00:00:00Z').toISOString() }));
    const recent = trace(tenant);
    await repo.save(recent);

    await repo.deleteOlderThan(new Date(Date.now() - 90 * 86_400_000));

    const left = await repo.query({ tenantId: tenant, page: 1, limit: 10 });
    expect(left.items.map((t) => t.requestId)).toEqual([recent.requestId]);
  });

  it('exposes filtered, paginated traces of the caller tenant over HTTP', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3017',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-traces-test',
      ...TEST_AUTH_ENV,
    });
    const tenant = (
      await new TenantRepository(prisma).createTenant({ name: `t-traces-h-${randomUUID()}` })
    ).id;
    const repo = new AiTraceRepository(prisma);
    for (let i = 0; i < 3; i++) await repo.save(trace(tenant, { outcome: 'SUCCESS' }));
    await repo.save(trace(tenant, { outcome: 'SECURITY_REJECTED' }));

    const practiceService = {} as PracticeApplicationService;
    const app = buildServer(config, createLogger(config), {
      principals: testPrincipals(),
      practiceService,
      tracer: new AITracer(200, { store: repo }),
      interpreterService: new InterpreterService({ complete: vi.fn() }),
      executorService: new ExecutorService({ practiceService }),
      contextService: {} as ContextService,
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
    try {
      const headers = authHeaders(tenant, randomUUID(), 'ADMIN');
      const res = await app.inject({
        method: 'GET',
        url: '/ai/traces?outcome=SUCCESS&limit=2&page=1',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: AITraceRecord[];
        meta: { total: number; totalPages: number };
      }>();
      expect(body.data).toHaveLength(2);
      expect(body.data.every((t) => t.outcome === 'SUCCESS' && t.tenantId === tenant)).toBe(true);
      expect(body.meta).toMatchObject({ total: 3, totalPages: 2 });

      for (const url of ['/ai/traces?outcome=NOPE', '/ai/traces?from=2026-10-05&to=2026-10-01']) {
        expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(400);
      }
      const member = await app.inject({
        method: 'GET',
        url: '/ai/traces',
        headers: authHeaders(tenant, randomUUID(), 'MEMBER'),
      });
      expect(member.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
