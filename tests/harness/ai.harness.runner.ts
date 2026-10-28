import { mkdir, writeFile } from 'node:fs/promises';

import dotenv from 'dotenv';

import { ContextService } from '../../src/ai/context/context.service.js';
import { DecisionEngine } from '../../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../../src/ai/execution/executor.service.js';
import { InterpreterService } from '../../src/ai/interpreter/interpreter.service.js';
import {
  NormalizationValidationError,
  NormalizerService,
} from '../../src/ai/normalization/normalizer.service.js';
import { createOpenAIProvider } from '../../src/ai/providers/openai.provider.js';
import { createDeterministicStubLLM } from '../../src/ai/providers/stub.provider.js';
import {
  enforceIdPriority,
  validateBeforeDecision,
  validateResolvedCommand,
} from '../../src/ai/validation/pre-execution.validator.js';
import { ValidationError } from '../../src/ai/validation/validation.errors.js';
import { validateTestEnv } from '../../src/config/env.validation.js';
import { PracticeApplicationService } from '../../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../../src/data/db/prisma.js';
import { TenantRepository } from '../../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../../src/data/repositories/user.repository.js';
import { buildServer } from '../../src/interface/http/server.js';
import { createLogger } from '../../src/shared/logger.js';
import { authHeaders, TEST_AUTH_SECRET } from '../helpers/auth.js';

import type {
  AIScenario,
  Classification,
  InfrastructureInfo,
  InfrastructureType,
  ScenarioResult,
  TestType,
} from './ai.harness.types.js';
import type { InterpreterOutput } from '../../src/ai/interpreter/interpreter.types.js';

dotenv.config({ path: '.env.test' });

type HarnessEnvironment = {
  db: 'connected' | 'not_connected';
  llm: 'real' | 'stub';
};

const DEFAULT_DELAY_MS = 250;
const DEFAULT_MAX_RETRIES = 2;
const DELAY_JITTER_MS = 100;
const RETRY_JITTER_RATIO = 0.2;

class HarnessInfrastructureError extends Error {
  constructor(
    message: string,
    public readonly infrastructure: InfrastructureInfo,
  ) {
    super(message);
    this.name = 'HarnessInfrastructureError';
  }
}

function isStrictMode(): boolean {
  return process.argv.includes('--mode=strict') || process.env.AI_TEST_MODE === 'strict';
}

function strictModeError(reasons: string[]): Error {
  const message = [
    '[strict-mode] STRICT MODE FAILED',
    '',
    '[env-check] Invalid environment:',
    ...reasons.map((r) => `- ${r}`),
    '',
    'Fix your .env.test file.',
  ].join('\n');
  return new Error(message);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(amount: number): number {
  return Math.floor(Math.random() * (amount * 2 + 1) - amount);
}

async function delayBeforeScenario(baseDelayMs: number): Promise<number> {
  const delayMs = Math.max(0, baseDelayMs + jitter(DELAY_JITTER_MS));
  await sleep(delayMs);
  return delayMs;
}

function getInfrastructureTypeFromMessage(msg: string): InfrastructureType | null {
  const lowered = msg.toLowerCase();
  if (lowered.includes(' 429 ') || lowered.includes('rate limit') || lowered.includes('quota'))
    return 'RATE_LIMIT';
  if (lowered.includes('timeout') || lowered.includes('aborterror')) return 'TIMEOUT';
  if (
    lowered.includes('network') ||
    lowered.includes('econnreset') ||
    lowered.includes('enotfound') ||
    lowered.includes('fetch failed') ||
    lowered.includes('request failed') ||
    lowered.includes('provider unavailable')
  ) {
    return 'NETWORK';
  }
  if (lowered.includes(' 5')) return 'NETWORK';
  return null;
}

function isRetriableMessage(msg: string): boolean {
  const lowered = msg.toLowerCase();
  return (
    lowered.includes(' 429 ') ||
    lowered.includes('rate limit') ||
    lowered.includes('quota') ||
    lowered.includes(' 50') ||
    lowered.includes(' 51') ||
    lowered.includes(' 52') ||
    lowered.includes(' 53') ||
    lowered.includes(' 54') ||
    lowered.includes('timeout') ||
    lowered.includes('aborterror') ||
    lowered.includes('network') ||
    lowered.includes('fetch failed') ||
    lowered.includes('request failed')
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
): Promise<{ value: T; retries: number }> {
  let retries = 0;
  while (retries <= maxRetries) {
    try {
      const value = await operation();
      return { value, retries };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const infraType = getInfrastructureTypeFromMessage(msg);
      const retriable = isRetriableMessage(msg);
      if (!retriable || infraType === null || retries >= maxRetries) {
        if (infraType !== null) {
          throw new HarnessInfrastructureError(msg, {
            type: infraType,
            retries,
            finalFailure: true,
          });
        }
        throw err;
      }
      const baseMs = 400 * Math.pow(2, retries);
      const backoffMs = Math.max(
        200,
        Math.round(baseMs * (1 + (Math.random() * 2 - 1) * RETRY_JITTER_RATIO)),
      );
      retries += 1;
      await sleep(backoffMs);
    }
  }
  throw new HarnessInfrastructureError('Retry exhausted', {
    type: 'NETWORK',
    retries: maxRetries,
    finalFailure: true,
  });
}

function isExecutorSuccess(value: unknown): value is { success: true } {
  return (
    typeof value === 'object' && value !== null && 'success' in value && value.success === true
  );
}

function isExecutorValidationError(
  value: unknown,
): value is { success: false; error: { code: string } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === false &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'code' in value.error &&
    value.error.code === 'VALIDATION_ERROR'
  );
}

function classify(args: {
  interpreted: InterpreterOutput;
  executionResult: unknown;
  expectedNextState?: string;
}): Classification {
  const { interpreted, executionResult, expectedNextState } = args;
  if (
    expectedNextState &&
    interpreted.action === 'transition_practice' &&
    interpreted.nextState !== expectedNextState
  ) {
    return 'WRONG_INTERPRETATION';
  }
  if (isExecutorSuccess(executionResult)) return 'SUCCESS';
  if (isExecutorValidationError(executionResult)) return 'VALIDATION_ERROR';
  return 'EXECUTION_ERROR';
}

function classifyError(err: unknown): {
  classification: Classification;
  infrastructure?: InfrastructureInfo;
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof HarnessInfrastructureError)
    return { classification: 'INFRASTRUCTURE_ERROR', infrastructure: err.infrastructure };
  if (err instanceof ValidationError) return { classification: 'VALIDATION_ERROR' };
  if (msg.includes('Ambiguous input')) return { classification: 'AMBIGUOUS' };
  if (msg.includes('valid JSON') || msg.includes('contract'))
    return { classification: 'VALIDATION_ERROR' };
  if (err instanceof NormalizationValidationError) return { classification: 'VALIDATION_ERROR' };
  if (isRetriableMessage(msg)) {
    const type = getInfrastructureTypeFromMessage(msg) ?? 'NETWORK';
    return {
      classification: 'INFRASTRUCTURE_ERROR',
      infrastructure: { type, retries: 0, finalFailure: true },
    };
  }
  return { classification: 'EXECUTION_ERROR' };
}

function summarize(results: ScenarioResult[]) {
  const base: Record<Classification, number> = {
    SUCCESS: 0,
    AMBIGUOUS: 0,
    VALIDATION_ERROR: 0,
    EXECUTION_ERROR: 0,
    WRONG_INTERPRETATION: 0,
    INFRASTRUCTURE_ERROR: 0,
  };
  for (const r of results) base[r.classification] += 1;
  return { total: results.length, ...base };
}

export type SegmentReport = {
  total: number;
  success: number;
  ambiguous: number;
  validationErrors: number;
  executionErrors: number;
  wrongInterpretation: number;
  infrastructureErrors: number;
  expectedValidationErrors: number;
  realSuccessRate?: number;
};

export type SegmentedReport = {
  core: SegmentReport;
  domain: SegmentReport;
  results: ScenarioResult[];
  environment: HarnessEnvironment;
};

export async function runHarness(args: {
  scenarios: AIScenario[];
  filterTypes: TestType[];
  reportPath?: string;
}): Promise<SegmentedReport> {
  const strict = isStrictMode();
  const env = process.env;
  const delayMs = parsePositiveInt(env.AI_TEST_DELAY_MS, DEFAULT_DELAY_MS);
  const maxRetries = parsePositiveInt(env.AI_TEST_MAX_RETRIES, DEFAULT_MAX_RETRIES);

  const envErrors = validateTestEnv(strict);
  if (envErrors.length > 0) {
    throw strictModeError(envErrors);
  }

  const logger = createLogger({
    NODE_ENV:
      env.NODE_ENV === 'production'
        ? 'production'
        : env.NODE_ENV === 'test'
          ? 'test'
          : 'development',
    SERVICE_NAME: env.SERVICE_NAME ?? 'sinfonia-ai-harness-segmented',
  });

  const llm =
    env.ENABLE_LLM === 'true' && env.OPENAI_API_KEY
      ? createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL })
      : createDeterministicStubLLM();

  const interpreter = new InterpreterService({ llm, log: logger });
  const environment: HarnessEnvironment = {
    db: 'not_connected',
    llm: interpreter.isRealLLM() ? 'real' : 'stub',
  };

  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) {
    if (strict) throw strictModeError(['DB not connected']);
    logger.warn('[harness] DATABASE_URL not configured. Skipping DB path.');
    const empty: SegmentedReport = {
      core: {
        total: 0,
        success: 0,
        ambiguous: 0,
        validationErrors: 0,
        executionErrors: 0,
        wrongInterpretation: 0,
        infrastructureErrors: 0,
        expectedValidationErrors: 0,
      },
      domain: {
        total: 0,
        success: 0,
        ambiguous: 0,
        validationErrors: 0,
        executionErrors: 0,
        wrongInterpretation: 0,
        infrastructureErrors: 0,
        expectedValidationErrors: 0,
        realSuccessRate: 0,
      },
      results: [],
      environment,
    };
    return empty;
  }

  const prisma = createPrismaClient(dbUrl);
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  environment.db = 'connected';

  const practiceService = new PracticeApplicationService(prisma);
  const executor = new ExecutorService({ practiceService });
  const decisionEngine = new DecisionEngine();
  const normalizerService = new NormalizerService();
  const contextService = new ContextService(practiceService);
  const app = buildServer(
    {
      NODE_ENV: environment.llm === 'real' ? 'production' : 'test',
      PORT: Number(env.PORT ?? 3001),
      DATABASE_URL: dbUrl,
      SERVICE_NAME: env.SERVICE_NAME ?? 'sinfonia-ai-harness-segmented',
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      ENABLE_LLM: env.ENABLE_LLM === 'true' || env.ENABLE_LLM === '1',
      OPENAI_MODEL: env.OPENAI_MODEL ?? 'gpt-4o-mini',
      AUTH_SECRET: TEST_AUTH_SECRET,
      AUTH_ISSUER: 'sinfonia',
      AUTH_AUDIENCE: 'sinfonia-api',
      AUTH_TTL_SECONDS: 3600,
      ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
      STORAGE_DRIVER: 'local',
      S3_REGION: 'eu-south-1',
      S3_FORCE_PATH_STYLE: false,
      SCHEDULER_INTERVAL_MS: 60_000,
      OUTBOX_DISPATCH_INTERVAL_MS: 5_000,
      OUTBOX_MAX_ATTEMPTS: 8,
      WHATSAPP_API_VERSION: 'v21.0',
      RATE_LIMIT_PER_MINUTE: 120,
      RATE_LIMIT_AI_PER_MINUTE: 20,
      RATE_LIMIT_TENANT_PER_MINUTE: 600,
      LLM_PROVIDER: 'openai',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
    },
    logger,
    {
      practiceService,
      interpreterService: interpreter,
      executorService: executor,
      contextService,
      decisionEngine,
      normalizerService,
    },
  );

  const tenantRepo = new TenantRepository(prisma);
  const userRepo = new UserRepository(prisma);

  const tenant = await tenantRepo.createTenant({ name: 'ai-segmented-tenant' });
  const user = await userRepo.createUser(tenant.id, {
    email: 'ai.segmented@test.local',
    role: 'OPERATOR',
  });

  async function clearArtistPractices(): Promise<void> {
    await prisma.$executeRaw`
      DELETE FROM "practice"
      WHERE "tenant_id" = ${tenant.id}::uuid
        AND "payload"->>'type' = 'artist_practice'
    `;
  }

  async function seedArtistPractice(nextState: 'CREATED' | 'VALIDATED' = 'CREATED') {
    const created = await practiceService.createPractice({
      tenantId: tenant.id,
      userId: user.id,
      name: 'Mario Rossi',
      kind: 'artist',
    });
    if (nextState === 'VALIDATED') {
      await practiceService.transitionPractice({
        tenantId: tenant.id,
        userId: user.id,
        practiceId: created.id,
        nextState: 'VALIDATED',
      });
    }
    return created;
  }

  const practice = await practiceService.createPractice({
    tenantId: tenant.id,
    userId: user.id,
    name: 'Harness practice',
    kind: 'generic',
  });
  const secondPractice = await practiceService.createPractice({
    tenantId: tenant.id,
    userId: user.id,
    name: 'Harness secondary practice',
    kind: 'generic',
  });

  const selected = args.scenarios.filter((s) => args.filterTypes.includes(s.type));
  const results: ScenarioResult[] = [];

  for (const scenario of selected) {
    const input = scenario.input.replaceAll('{{PRACTICE_ID}}', practice.id);
    await delayBeforeScenario(delayMs);
    await clearArtistPractices();

    const row: ScenarioResult = {
      scenarioId: scenario.id,
      type: scenario.type,
      category: scenario.category,
      input,
      expectedBehavior: scenario.expectedBehavior,
      expectedNextState: scenario.expectedNextState,
      classification: 'EXECUTION_ERROR',
    };

    try {
      // Context shaping for core scenarios (keep it stable/deterministic).
      const twoCreatedContext = scenario.id === 'context-02';
      const implicitSingleContext = scenario.id === 'context-01';
      const secondPracticeStatus: 'CREATED' | 'COMPLETED' = twoCreatedContext
        ? 'CREATED'
        : 'COMPLETED';

      await prisma.practice.updateMany({
        where: { tenantId: tenant.id, id: practice.id },
        data: { status: 'CREATED', version: { increment: 1 } },
      });
      await prisma.practice.updateMany({
        where: { tenantId: tenant.id, id: secondPractice.id },
        data: { status: secondPracticeStatus, version: { increment: 1 } },
      });

      // Domain seeding / isolation (kept here to ensure deterministic context for domain KPIs).
      if (scenario.type === 'domain') {
        if (scenario.id === 'artist-02') {
          await seedArtistPractice('CREATED');
        }
        if (scenario.id === 'artist-03') {
          await seedArtistPractice('VALIDATED');
        }
        if (scenario.id === 'artist-invalid-01') {
          await seedArtistPractice('CREATED');
        }
        if (scenario.id === 'artist-amb-01') {
          await seedArtistPractice('CREATED');
          await seedArtistPractice('CREATED');
        }
      }

      const contextPractices = twoCreatedContext
        ? [
            {
              id: practice.id,
              status: 'CREATED' as const,
              type: 'generic practice',
              summary: `generic practice ${practice.id}`,
            },
            {
              id: secondPractice.id,
              status: 'CREATED' as const,
              type: 'generic practice',
              summary: `generic practice ${secondPractice.id}`,
            },
          ]
        : implicitSingleContext
          ? [
              {
                id: practice.id,
                status: 'CREATED' as const,
                type: 'onboarding cliente',
                summary: 'pratica creazione cliente Mario Rossi',
                name: 'Mario Rossi',
              },
            ]
          : scenario.type === 'core'
            ? [
                {
                  id: practice.id,
                  status: 'CREATED' as const,
                  type: 'generic practice',
                  summary: `generic practice ${practice.id}`,
                },
              ]
            : (await contextService.getPracticeContext(tenant.id, user.id)).practices;

      const interpretedResult = await withRetry(
        () =>
          interpreter.interpret(input, {
            tenantId: tenant.id,
            userId: user.id,
            practices: contextPractices,
          }),
        maxRetries,
      );
      const interpreted = interpretedResult.value;
      row.interpreterOutput = interpreted;

      const normalized = enforceIdPriority(normalizerService.normalize(interpreted));
      if (normalized.action === 'create_practice') {
        const cmd = { action: 'create_practice', data: { artistName: normalized.artistName } };
        const execution = await executor.execute(cmd, { tenantId: tenant.id, userId: user.id });
        row.executionResult = execution;
        row.classification = classify({
          interpreted,
          executionResult: execution,
          expectedNextState: scenario.expectedNextState,
        });
        results.push(row);
        continue;
      }

      validateBeforeDecision(normalized, contextPractices);
      const resolved = decisionEngine.resolveCommand(normalized, {
        tenantId: tenant.id,
        userId: user.id,
        practices: contextPractices,
      });
      validateResolvedCommand(resolved, contextPractices);
      const execution = await executor.execute(resolved, { tenantId: tenant.id, userId: user.id });
      row.executionResult = execution;

      // Hit HTTP path too (for stability). Do not fail scenario on 400; classification is on executor result.
      const http = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenant.id, user.id, 'ADMIN'),
        payload: { input },
      });
      row.httpResponse = { statusCode: http.statusCode, body: http.json() };

      row.classification = classify({
        interpreted,
        executionResult: execution,
        expectedNextState: scenario.expectedNextState,
      });
      if (interpretedResult.retries > 0) {
        row.infrastructure = {
          type: 'NETWORK',
          retries: interpretedResult.retries,
          finalFailure: false,
        };
      }
    } catch (err: unknown) {
      const classified = classifyError(err);
      row.classification = classified.classification;
      row.infrastructure = classified.infrastructure;
      row.notes = err instanceof Error ? err.message : String(err);
    }
    results.push(row);
  }

  await app.close();
  await prisma.$disconnect();

  // Segmented reporting (core vs domain only).
  const coreResults = results.filter((r) => r.type === 'core');
  const domainResults = results.filter((r) => r.type === 'domain');

  const coreSummary = summarize(coreResults);
  const domainSummary = summarize(domainResults);
  const coreExpectedValidationErrors = coreResults.filter(
    (r) => r.expectedBehavior === 'ERROR',
  ).length;
  const domainExpectedValidationErrors = domainResults.filter(
    (r) => r.expectedBehavior === 'ERROR',
  ).length;

  const coreReport: SegmentReport = {
    total: coreSummary.total,
    success: coreSummary.SUCCESS,
    ambiguous: coreSummary.AMBIGUOUS,
    validationErrors: coreSummary.VALIDATION_ERROR,
    executionErrors: coreSummary.EXECUTION_ERROR,
    wrongInterpretation: coreSummary.WRONG_INTERPRETATION,
    infrastructureErrors: coreSummary.INFRASTRUCTURE_ERROR,
    expectedValidationErrors: coreExpectedValidationErrors,
  };

  // Business KPI: measure success rate over scenarios that are expected to succeed.
  const domainExpectedSuccess = domainResults.filter(
    (r) => r.expectedBehavior === 'SUCCESS',
  ).length;
  const domainActualSuccess = domainResults.filter(
    (r) => r.expectedBehavior === 'SUCCESS' && r.classification === 'SUCCESS',
  ).length;
  const domainRealSuccessRate =
    domainExpectedSuccess === 0 ? 0 : domainActualSuccess / domainExpectedSuccess;
  const domainReport: SegmentReport = {
    total: domainSummary.total,
    success: domainSummary.SUCCESS,
    ambiguous: domainSummary.AMBIGUOUS,
    validationErrors: domainSummary.VALIDATION_ERROR,
    executionErrors: domainSummary.EXECUTION_ERROR,
    wrongInterpretation: domainSummary.WRONG_INTERPRETATION,
    infrastructureErrors: domainSummary.INFRASTRUCTURE_ERROR,
    expectedValidationErrors: domainExpectedValidationErrors,
    realSuccessRate: domainRealSuccessRate,
  };

  const report: SegmentedReport = { core: coreReport, domain: domainReport, results, environment };

  const outPath = args.reportPath ?? 'reports/ai-behavior-report.json';
  await mkdir('reports', { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nAI SEGMENTED REPORT\n');
  console.log(`Environment: db=${environment.db}, llm=${environment.llm}`);
  console.log(
    `CORE: total=${coreReport.total} execErr=${coreReport.executionErrors} infra=${coreReport.infrastructureErrors}`,
  );
  console.log(
    `DOMAIN: total=${domainReport.total} success=${domainReport.success} valErr=${domainReport.validationErrors} realSuccessRate=${domainReport.realSuccessRate?.toFixed(3)}`,
  );

  return report;
}
