import { describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV } from './helpers/auth.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

const stubLLM: LLMClient = { complete: () => Promise.reject(new Error('stub')) };

const DATABASE_URL = process.env.DATABASE_URL;
const itWithDb = it.runIf(Boolean(DATABASE_URL));

type ApiResponse<T> = {
  success: boolean;
  data: T;
};

type CreatedPracticeData = {
  id: string;
  name: string;
  kind: string;
  schemaVersion: number;
  status: string;
};

type PaginatedPracticeData = {
  items: Array<{ id: string; name: string }>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type ExportPracticeData = {
  csv: string;
  practices: unknown[];
};

describe('practice HTTP API (Phase 2B)', () => {
  itWithDb('supports create, get, list with pagination/search, and export', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3002',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-practice-api-test',
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

      const tenant = await tenantRepo.createTenant({ name: 't-api-2b' });
      const admin = await userRepo.createUser(tenant.id, {
        email: 'admin@api2b.local',
        role: 'ADMIN',
      });
      const member = await userRepo.createUser(tenant.id, {
        email: 'member@api2b.local',
        role: 'MEMBER',
      });

      // 1. POST /practices — Member creates practice
      const createRes = await app.inject({
        method: 'POST',
        url: '/practices',
        headers: authHeaders(tenant.id, member.id, 'MEMBER'),
        payload: {
          name: 'Tour Europeo 2026',
          kind: 'music',
          metadata: { venue: 'Berlin Arena' },
        },
      });

      expect(createRes.statusCode).toBe(201);
      const createJson = createRes.json<ApiResponse<CreatedPracticeData>>();
      expect(createJson.success).toBe(true);
      expect(createJson.data.name).toBe('Tour Europeo 2026');
      expect(createJson.data.kind).toBe('music');
      expect(createJson.data.schemaVersion).toBe(1);
      expect(createJson.data.status).toBe('CREATED');
      const practiceId = createJson.data.id;

      // Create a second practice
      await app.inject({
        method: 'POST',
        url: '/practices',
        headers: authHeaders(tenant.id, member.id, 'MEMBER'),
        payload: {
          name: 'Mostra Fotografica',
          kind: 'artist',
        },
      });

      // 2. GET /practices/:id — Get details
      const getRes = await app.inject({
        method: 'GET',
        url: `/practices/${practiceId}`,
        headers: authHeaders(tenant.id, member.id, 'MEMBER'),
      });

      expect(getRes.statusCode).toBe(200);
      const getJson = getRes.json<ApiResponse<CreatedPracticeData>>();
      expect(getJson.success).toBe(true);
      expect(getJson.data.id).toBe(practiceId);
      expect(getJson.data.name).toBe('Tour Europeo 2026');

      // 3. GET /practices — Paginated list
      const listRes = await app.inject({
        method: 'GET',
        url: '/practices?page=1&limit=1',
        headers: authHeaders(tenant.id, member.id, 'MEMBER'),
      });

      expect(listRes.statusCode).toBe(200);
      const listJson = listRes.json<ApiResponse<PaginatedPracticeData>>();
      expect(listJson.success).toBe(true);
      expect(listJson.data.items).toHaveLength(1);
      expect(listJson.data.total).toBe(2);
      expect(listJson.data.page).toBe(1);
      expect(listJson.data.limit).toBe(1);
      expect(listJson.data.totalPages).toBe(2);

      // 4. GET /practices with search query
      const searchRes = await app.inject({
        method: 'GET',
        url: '/practices?search=Europeo',
        headers: authHeaders(tenant.id, member.id, 'MEMBER'),
      });

      expect(searchRes.statusCode).toBe(200);
      const searchJson = searchRes.json<ApiResponse<PaginatedPracticeData>>();
      expect(searchJson.success).toBe(true);
      expect(searchJson.data.items).toHaveLength(1);
      expect(searchJson.data.items[0]?.name).toBe('Tour Europeo 2026');

      // 5. POST /practices/export — Export CSV
      const exportRes = await app.inject({
        method: 'POST',
        url: '/practices/export',
        headers: authHeaders(tenant.id, admin.id, 'ADMIN'),
        payload: {
          filter: { type: 'today' },
        },
      });

      expect(exportRes.statusCode).toBe(200);
      const exportJson = exportRes.json<ApiResponse<ExportPracticeData>>();
      expect(exportJson.success).toBe(true);
      expect(exportJson.data.csv).toContain('Tour Europeo 2026');
      expect(exportJson.data.csv).toContain('Mostra Fotografica');
      expect(exportJson.data.practices).toHaveLength(2);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
