import { describe, expect, it, vi } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import {
  createDisabledLLMClient,
  LLMDisabledError,
} from '../src/ai/providers/disabled.provider.js';
import { AITracer } from '../src/ai/tracing/ai.tracer.js';
import { loadConfig } from '../src/config/config.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';
import type {
  PracticeApplicationService,
  PracticeView,
} from '../src/core/practice/practice.application.service.js';

function createMockPracticeView(overrides: Partial<PracticeView> = {}): PracticeView {
  return {
    id: overrides.id ?? '550e8400-e29b-41d4-a716-446655440000',
    tenantId: overrides.tenantId ?? 'tenant-a',
    userId: overrides.userId ?? 'user-a',
    status: overrides.status ?? 'CREATED',
    version: overrides.version ?? 1,
    schemaVersion: overrides.schemaVersion ?? 1,
    name: overrides.name ?? 'Pratica Test',
    kind: overrides.kind ?? 'generic',
    typeLabel: overrides.typeLabel ?? 'generic practice',
    summary: overrides.summary ?? 'pratica generica Test',
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

describe('Phase 3A: Explicit LLM Mode, AI Tracing & Advanced Context Retrieval', () => {
  const baseConfig = loadConfig({
    NODE_ENV: 'test',
    PORT: '3008',
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
    SERVICE_NAME: 'sinfonia-phase3a-test',
    ...TEST_AUTH_ENV,
  });
  const logger = createLogger(baseConfig);

  // -------------------------------------------------------------------------
  // 1. Modalità LLM Esplicita (Disabled LLM vs Deterministic Fallback)
  // -------------------------------------------------------------------------
  describe('Explicit LLM Mode', () => {
    it('disabled LLM client rejects directly with LLMDisabledError (no silent stub)', async () => {
      const client = createDisabledLLMClient('Testing disabled client');
      expect(client.mode).toBe('disabled');

      await expect(client.complete('test')).rejects.toThrow(LLMDisabledError);
      await expect(client.completeDetailed!('test')).rejects.toThrow(LLMDisabledError);
    });

    it('InterpreterService reports isLLMEnabled false when configured with disabled client', async () => {
      const disabledClient = createDisabledLLMClient();
      const service = new InterpreterService(disabledClient);

      expect(service.isLLMEnabled()).toBe(false);
      expect(service.isRealLLM()).toBe(false);
      await expect(service.interpret('valida la pratica')).rejects.toThrow(LLMDisabledError);
    });

    it('POST /ai/execute: returns 503 LLM_DISABLED with clear message on natural input when LLM disabled', async () => {
      const tenantId = '11111111-1111-4111-8111-111111111111';
      const userId = '22222222-2222-4222-8222-222222222222';

      const mockPracticeService = {
        listPractices: vi.fn().mockResolvedValue([]),
        executeCommand: vi.fn(),
      } as unknown as PracticeApplicationService;

      const disabledLLM = createDisabledLLMClient();
      const interpreterService = new InterpreterService(disabledLLM);
      const executorService = new ExecutorService({ practiceService: mockPracticeService });
      const contextService = new ContextService(mockPracticeService);
      const decisionEngine = new DecisionEngine();
      const normalizerService = new NormalizerService();
      const tracer = new AITracer();

      const app = buildServer(baseConfig, logger, {
        practiceService: mockPracticeService,
        interpreterService,
        executorService,
        contextService,
        decisionEngine,
        normalizerService,
        tracer,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenantId, userId, 'OPERATOR'),
        payload: { input: 'per favore valida questa pratica' },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json<{
        success: boolean;
        error: { code: string; message: string; availableCommands: string[] };
        meta?: { trace?: { outcome: string } };
      }>();

      expect(body.success).toBe(false);
      expect(body.error.code).toBe('LLM_DISABLED');
      expect(body.error.message).toContain('Il motore AI/LLM è disabilitato');
      expect(body.error.availableCommands).toBeDefined();
      expect(body.meta?.trace?.outcome).toBe('LLM_DISABLED');

      await app.close();
    });

    it('POST /ai/execute: routes deterministic command directly when LLM disabled', async () => {
      const tenantId = '33333333-3333-4333-8333-333333333333';
      const userId = '44444444-4444-4444-8444-444444444444';

      const mockPracticeService = {
        listPractices: vi.fn().mockResolvedValue([]),
        executeCommand: vi.fn().mockResolvedValue({
          type: 'created',
          practice: { name: 'Pratica Deterministica 3A', status: 'CREATED' },
        }),
      } as unknown as PracticeApplicationService;

      const disabledLLM = createDisabledLLMClient();
      const interpreterService = new InterpreterService(disabledLLM);
      const executorService = new ExecutorService({ practiceService: mockPracticeService });
      const contextService = new ContextService(mockPracticeService);
      const decisionEngine = new DecisionEngine();
      const normalizerService = new NormalizerService();
      const tracer = new AITracer();

      const app = buildServer(baseConfig, logger, {
        practiceService: mockPracticeService,
        interpreterService,
        executorService,
        contextService,
        decisionEngine,
        normalizerService,
        tracer,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenantId, userId, 'OPERATOR'),
        payload: { input: 'crea pratica Pratica Deterministica 3A' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        success: boolean;
        mode: string;
        result: { type: string; practice: { name: string; status: string } };
        meta: { trace: { outcome: string; model: string } };
      }>();

      expect(body.success).toBe(true);
      expect(body.mode).toBe('deterministic');
      expect(body.result.type).toBe('created');
      expect(body.result.practice.name).toBe('Pratica Deterministica 3A');
      expect(body.meta.trace.outcome).toBe('DETERMINISTIC_FALLBACK');

      await app.close();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tracing del Percorso AI (requestId, tenant, modello, token, latenza, esito)
  // -------------------------------------------------------------------------
  describe('AI Tracing Subsystem', () => {
    it('records and filters AI traces correctly', () => {
      const tracer = new AITracer();

      tracer.record({
        requestId: 'req-001',
        tenantId: 'tenant-alpha',
        userId: 'user-1',
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokens: { promptTokens: 45, completionTokens: 18, totalTokens: 63 },
        latencyMs: 120,
        outcome: 'SUCCESS',
        action: 'create_practice',
        timestamp: new Date().toISOString(),
      });

      tracer.record({
        requestId: 'req-002',
        tenantId: 'tenant-beta',
        userId: 'user-2',
        model: 'none',
        provider: 'disabled',
        latencyMs: 5,
        outcome: 'LLM_DISABLED',
        timestamp: new Date().toISOString(),
      });

      const alphaTraces = tracer.getTraces({ tenantId: 'tenant-alpha' });
      expect(alphaTraces).toHaveLength(1);
      expect(alphaTraces[0]?.requestId).toBe('req-001');
      expect(alphaTraces[0]?.tokens?.totalTokens).toBe(63);
      expect(alphaTraces[0]?.outcome).toBe('SUCCESS');

      const disabledTraces = tracer.getTraces({ outcome: 'LLM_DISABLED' });
      expect(disabledTraces).toHaveLength(1);
      expect(disabledTraces[0]?.tenantId).toBe('tenant-beta');

      const lastTrace = tracer.getLastTrace();
      expect(lastTrace?.requestId).toBe('req-002');
    });

    it('POST /ai/execute attaches complete trace metadata and GET /ai/traces exposes them per-tenant', async () => {
      const tenantId = '55555555-5555-4555-8555-555555555555';
      const adminId = '66666666-6666-4666-8666-666666666666';

      const mockPractice = createMockPracticeView({
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Traced Artist',
        tenantId,
        userId: adminId,
      });

      const mockPracticeService = {
        listPractices: vi.fn().mockResolvedValue([mockPractice]),
        createPractice: vi.fn().mockResolvedValue(mockPractice),
      } as unknown as PracticeApplicationService;

      const mockLLM: LLMClient = {
        mode: 'real',
        model: 'gpt-4o-mini-test',
        providerName: 'openai',
        complete: () =>
          Promise.resolve(
            JSON.stringify({
              action: 'create_practice',
              artistName: 'Traced Artist',
              nextState: 'CREATED',
            }),
          ),
        completeDetailed: () =>
          Promise.resolve({
            text: JSON.stringify({
              action: 'create_practice',
              artistName: 'Traced Artist',
              nextState: 'CREATED',
            }),
            model: 'gpt-4o-mini-test',
            provider: 'openai',
            usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
          }),
      };

      const interpreterService = new InterpreterService(mockLLM);
      const executorService = new ExecutorService({ practiceService: mockPracticeService });
      const contextService = new ContextService(mockPracticeService);
      const decisionEngine = new DecisionEngine();
      const normalizerService = new NormalizerService();
      const tracer = new AITracer();

      const app = buildServer(baseConfig, logger, {
        practiceService: mockPracticeService,
        interpreterService,
        executorService,
        contextService,
        decisionEngine,
        normalizerService,
        tracer,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenantId, adminId, 'ADMIN'),
        payload: { input: 'crea pratica per Traced Artist' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        success: boolean;
        meta: {
          trace: {
            requestId: string;
            tenantId: string;
            userId: string;
            model: string;
            provider: string;
            tokens?: { totalTokens: number };
            latencyMs: number;
            outcome: string;
            action: string;
          };
        };
      }>();

      expect(body.meta.trace).toBeDefined();
      expect(body.meta.trace.tenantId).toBe(tenantId);
      expect(body.meta.trace.userId).toBe(adminId);
      expect(body.meta.trace.model).toBe('gpt-4o-mini-test');
      expect(body.meta.trace.tokens?.totalTokens).toBe(45);
      expect(body.meta.trace.outcome).toBe('SUCCESS');
      expect(body.meta.trace.action).toBe('create_practice');
      expect(body.meta.trace.latencyMs).toBeGreaterThanOrEqual(0);

      // Test GET /ai/traces endpoint
      const tracesRes = await app.inject({
        method: 'GET',
        url: '/ai/traces',
        headers: authHeaders(tenantId, adminId, 'ADMIN'),
      });

      expect(tracesRes.statusCode).toBe(200);
      const tracesBody = tracesRes.json<{
        success: boolean;
        data: Array<{ requestId: string; tenantId: string; outcome: string }>;
      }>();

      expect(tracesBody.success).toBe(true);
      expect(tracesBody.data.length).toBeGreaterThanOrEqual(1);
      const currentTrace = tracesBody.data.find((t) => t.requestId === body.meta.trace.requestId);
      expect(currentTrace).toBeDefined();
      expect(currentTrace?.tenantId).toBe(tenantId);
      expect(currentTrace?.outcome).toBe('SUCCESS');

      await app.close();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Context Retrieval Tenant-Scoped con Ricerca e Paginazione
  // -------------------------------------------------------------------------
  describe('Tenant-Scoped Context Retrieval', () => {
    it('enforces strict tenant isolation, search filtering, and pagination on context', async () => {
      const pA1 = createMockPracticeView({
        id: '550e8400-e29b-41d4-a716-446655440001',
        tenantId: 'tenant-a',
        userId: 'user-a',
        name: 'Contratto SinfonIA Alpha',
      });
      const pA2 = createMockPracticeView({
        id: '550e8400-e29b-41d4-a716-446655440002',
        tenantId: 'tenant-a',
        userId: 'user-a',
        name: 'Licenza Software Beta',
      });
      const pA3 = createMockPracticeView({
        id: '550e8400-e29b-41d4-a716-446655440003',
        tenantId: 'tenant-a',
        userId: 'user-a',
        name: 'Contratto Gamma',
      });
      const pB1 = createMockPracticeView({
        id: '550e8400-e29b-41d4-a716-446655440004',
        tenantId: 'tenant-b',
        userId: 'user-b',
        name: 'Contratto Segreto Tenant B',
      });

      const store: PracticeView[] = [pA1, pA2, pA3, pB1];

      const mockPracticeService = {
        listPractices: vi.fn(
          ({
            tenantId,
            search,
            status,
            limit,
          }: {
            tenantId: string;
            search?: string;
            status?: string;
            limit?: number;
          }) => {
            let items = store.filter((p) => p.tenantId === tenantId);
            if (status) items = items.filter((p) => p.status === status);
            if (search) {
              const lower = search.toLowerCase();
              items = items.filter((p) => p.name.toLowerCase().includes(lower) || p.id === search);
            }
            if (limit) items = items.slice(0, limit);
            return Promise.resolve(items);
          },
        ),
        listPracticesPaginated: vi.fn(
          ({
            tenantId,
            search,
            status,
            page = 1,
            limit = 20,
          }: {
            tenantId: string;
            search?: string;
            status?: string;
            page?: number;
            limit?: number;
          }) => {
            let items = store.filter((p) => p.tenantId === tenantId);
            if (status) items = items.filter((p) => p.status === status);
            if (search) {
              const lower = search.toLowerCase();
              items = items.filter((p) => p.name.toLowerCase().includes(lower) || p.id === search);
            }
            const total = items.length;
            const offset = (page - 1) * limit;
            const paginated = items.slice(offset, offset + limit);
            return Promise.resolve({
              items: paginated,
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            });
          },
        ),
      } as unknown as PracticeApplicationService;

      const contextService = new ContextService(mockPracticeService);

      // 1. Strict Tenant Isolation: Tenant A context never includes Tenant B
      const ctxA = await contextService.getPracticeContext('tenant-a', 'user-a');
      expect(ctxA.practices).toHaveLength(3);
      expect(ctxA.practices.some((p) => p.name?.includes('Tenant B'))).toBe(false);

      // 2. Context with Search Filter
      const searchCtx = await contextService.getPracticeContext('tenant-a', 'user-a', {
        search: 'SinfonIA',
      });
      expect(searchCtx.practices).toHaveLength(1);
      expect(searchCtx.practices[0]?.name).toBe('Contratto SinfonIA Alpha');

      // 3. Context with Pagination (page 1, limit 2)
      const paginatedCtx1 = await contextService.getPracticeContext('tenant-a', 'user-a', {
        page: 1,
        limit: 2,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });
      expect(paginatedCtx1.practices).toHaveLength(2);
      expect(paginatedCtx1.totalCount).toBe(3);
      expect(paginatedCtx1.page).toBe(1);

      // Page 2
      const paginatedCtx2 = await contextService.getPracticeContext('tenant-a', 'user-a', {
        page: 2,
        limit: 2,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });
      expect(paginatedCtx2.practices).toHaveLength(1);
      expect(paginatedCtx2.page).toBe(2);

      // 4. Relevant context detection from natural query text
      const relevantCtx = await contextService.getRelevantPracticeContext(
        'tenant-a',
        `Vorrei aggiornare la pratica ${pA1.id} per favore`,
        'user-a',
      );
      expect(relevantCtx.practices).toHaveLength(1);
      expect(relevantCtx.practices[0]?.id).toBe(pA1.id);
    });
  });
});
