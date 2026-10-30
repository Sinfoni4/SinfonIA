import { mkdir, writeFile } from 'node:fs/promises';

import dotenv from 'dotenv';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import {
  NormalizationValidationError,
  NormalizerService,
} from '../src/ai/normalization/normalizer.service.js';
import { createOpenAIProvider } from '../src/ai/providers/openai.provider.js';
import { createDeterministicStubLLM } from '../src/ai/providers/stub.provider.js';
import {
  enforceIdPriority,
  validateBeforeDecision,
  validateResolvedCommand,
} from '../src/ai/validation/pre-execution.validator.js';
import { ValidationError } from '../src/ai/validation/validation.errors.js';
import { validateTestEnv } from '../src/config/env.validation.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { AI_BEHAVIOR_SCENARIOS, type ScenarioCategory } from './ai.behavior.scenarios.js';
import { authHeaders, TEST_AUTH_SECRET, testPrincipals } from './helpers/auth.js';

import type { InterpreterOutput } from '../src/ai/interpreter/interpreter.types.js';

dotenv.config({ path: '.env.test' });

type Classification =
  | 'SUCCESS'
  | 'AMBIGUOUS'
  | 'VALIDATION_ERROR'
  | 'EXECUTION_ERROR'
  | 'WRONG_INTERPRETATION'
  | 'INFRASTRUCTURE_ERROR';

type InfrastructureType = 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK';

type InfrastructureInfo = {
  type: InfrastructureType;
  retries: number;
  finalFailure: boolean;
};

interface ScenarioResult {
  scenarioId: string;
  category: ScenarioCategory;
  input: string;
  interpreterOutput?: unknown;
  executionResult?: unknown;
  httpResponse?: { statusCode: number; body: unknown };
  classification: Classification;
  notes?: string;
  infrastructure?: InfrastructureInfo;
}

type HarnessEnvironment = {
  db: 'connected' | 'not_connected';
  llm: 'real' | 'stub';
};

const DEFAULT_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DELAY_JITTER_MS = 200;
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
    'Environment issues:',
    ...reasons.map((r) => `- ${r}`),
    '',
    'Infrastructure issues:',
    '- Docker permission denied or daemon unavailable',
    '',
    'Fix steps:',
    '1. Fix Docker access',
    '2. Configure .env.test',
    '3. Restart test',
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
  const half = amount;
  return Math.floor(Math.random() * (half * 2 + 1) - half);
}

async function delayBeforeScenario(baseDelayMs: number): Promise<number> {
  const delayMs = Math.max(0, baseDelayMs + jitter(DELAY_JITTER_MS));
  console.log(`[ai-harness] scenario delayed by ${delayMs} ms`);
  await sleep(delayMs);
  return delayMs;
}

function getInfrastructureTypeFromMessage(msg: string): InfrastructureType | null {
  const lowered = msg.toLowerCase();
  if (lowered.includes(' 429 ') || lowered.includes('rate limit') || lowered.includes('quota')) {
    return 'RATE_LIMIT';
  }
  if (lowered.includes('timeout') || lowered.includes('aborterror')) {
    return 'TIMEOUT';
  }
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
  if (lowered.includes(' 5')) {
    return 'NETWORK';
  }
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
  let lastError: unknown = null;
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

      const baseMs = 1000 * Math.pow(2, retries);
      const backoffMs = Math.max(
        200,
        Math.round(baseMs * (1 + (Math.random() * 2 - 1) * RETRY_JITTER_RATIO)),
      );
      console.log(`[ai-harness] retry attempt ${retries + 1}/${maxRetries} in ${backoffMs} ms`);
      if (infraType === 'RATE_LIMIT') {
        console.log('[ai-harness] rate limited, backing off');
      }
      retries += 1;
      lastError = err;
      await sleep(backoffMs);
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new HarnessInfrastructureError(msg, {
    type: 'NETWORK',
    retries: maxRetries,
    finalFailure: true,
  });
}

async function main(): Promise<void> {
  const strict = isStrictMode();
  const env = process.env;
  const delayMs = parsePositiveInt(env.AI_TEST_DELAY_MS, DEFAULT_DELAY_MS);
  const maxRetries = parsePositiveInt(env.AI_TEST_MAX_RETRIES, DEFAULT_MAX_RETRIES);
  const envErrors = validateTestEnv(strict);
  if (envErrors.length > 0) {
    throw new Error(
      [
        '[strict-mode] STRICT MODE FAILED',
        '',
        '[env-check] Invalid environment:',
        ...envErrors.map((e) => `- ${e}`),
        '',
        'Fix your .env.test file.',
      ].join('\n'),
    );
  }

  const logger = createLogger({
    NODE_ENV:
      env.NODE_ENV === 'production'
        ? 'production'
        : env.NODE_ENV === 'test'
          ? 'test'
          : 'development',
    SERVICE_NAME: env.SERVICE_NAME ?? 'sinfonia-ai-harness',
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
  const preflightReasons: string[] = [];
  if (environment.llm !== 'real') {
    preflightReasons.push('LLM not enabled (real provider not active)');
  }

  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) {
    preflightReasons.push('DB not connected');
    if (strict) throw strictModeError(preflightReasons);
    logger.warn(
      '[strict-mode] DATABASE_URL not configured. Running interpreter-only behavior harness.',
    );
    await runInterpreterOnly(interpreter, environment, delayMs, maxRetries);
    return;
  }

  const prisma = createPrismaClient(dbUrl);
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    environment.db = 'connected';
  } catch {
    preflightReasons.push('DB not connected');
  }

  if (strict && preflightReasons.length > 0) {
    await prisma.$disconnect().catch(() => undefined);
    throw strictModeError(preflightReasons);
  }
  if (environment.db !== 'connected') {
    logger.warn('[strict-mode] Database not reachable. Running interpreter-only behavior harness.');
    await prisma.$disconnect().catch(() => undefined);
    await runInterpreterOnly(interpreter, environment, delayMs, maxRetries);
    return;
  }

  try {
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
        SERVICE_NAME: env.SERVICE_NAME ?? 'sinfonia-ai-harness',
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
        AI_TRACE_RETENTION_DAYS: 90,
        LLM_PROVIDER: 'openai',
        AZURE_OPENAI_API_VERSION: '2024-10-21',
        AUTH_EMAIL_LOGIN: false,
        AUTH_DEV_SHOW_CODE: false,
        RATE_LIMIT_AUTH_PER_MINUTE: 10,
        MISTRAL_MODEL: 'mistral-small-latest',
      },
      logger,
      {
        principals: testPrincipals(),
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

    const tenant = await tenantRepo.createTenant({ name: 'ai-behavior-tenant' });
    const user = await userRepo.createUser(tenant.id, {
      email: 'ai.behavior@test.local',
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

    const results: ScenarioResult[] = [];
    for (const scenario of AI_BEHAVIOR_SCENARIOS) {
      // Canonical DB isolation: only artist practices are reset per scenario.
      await clearArtistPractices();
      const input = scenario.input.replaceAll('{{PRACTICE_ID}}', practice.id);
      await delayBeforeScenario(delayMs);
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

      const row: ScenarioResult = {
        scenarioId: scenario.id,
        category: scenario.category,
        input,
        classification: 'EXECUTION_ERROR',
      };

      try {
        // Scenario-specific seeding for artist practices.
        if (scenario.id === 'artist-amb-01') {
          await seedArtistPractice('CREATED');
          await seedArtistPractice('CREATED');
        }
        if (scenario.id === 'artist-02') {
          await seedArtistPractice('CREATED');
        }
        if (scenario.id === 'artist-03') {
          await seedArtistPractice('VALIDATED');
        }
        if (scenario.id === 'artist-val-01') {
          await seedArtistPractice('CREATED'); // still CREATED, completing should fail validation
        }

        const isArtistScenario = scenario.id.startsWith('artist-');
        const contextPractices =
          // Preserve the original special-cased contexts for legacy scenarios.
          twoCreatedContext
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
              : isArtistScenario
                ? (await contextService.getPracticeContext(tenant.id, user.id)).practices
                : [
                    {
                      id: practice.id,
                      status: 'CREATED' as const,
                      type: 'generic practice',
                      summary: `generic practice ${practice.id}`,
                    },
                  ];

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
        console.log('[ai-flow]', { step: 'interpret', input, output: interpreted });
        const normalized = enforceIdPriority(normalizerService.normalize(interpreted));
        console.log('[ai-flow]', { step: 'normalize', input: interpreted, output: normalized });

        if (normalized.action === 'create_practice') {
          const cmd = { action: 'create_practice', data: { artistName: normalized.artistName } };
          console.log('[ai-flow]', { step: 'decision', input: normalized, output: cmd });
          const execution = await executor.execute(cmd, { tenantId: tenant.id, userId: user.id });
          row.executionResult = execution;
          console.log('[ai-flow]', { step: 'execute', input: cmd, output: execution });
          row.classification = classify({
            interpreted,
            executionResult: execution,
            expectedNextState: scenario.expectedNextState,
          });
          row.notes = `Expected behavior: ${scenario.expectedBehavior}`;
          results.push(row);
          continue;
        }

        validateBeforeDecision(normalized, contextPractices);
        const resolved = decisionEngine.resolveCommand(normalized, {
          tenantId: tenant.id,
          userId: user.id,
          practices: contextPractices,
        });
        console.log('[ai-flow]', { step: 'decision', input: normalized, output: resolved });

        validateResolvedCommand(resolved, contextPractices);

        const execution = await executor.execute(resolved, {
          tenantId: tenant.id,
          userId: user.id,
        });
        row.executionResult = execution;
        console.log('[ai-flow]', { step: 'execute', input: resolved, output: execution });

        await delayBeforeScenario(delayMs);
        const http = await app.inject({
          method: 'POST',
          url: '/ai/execute',
          headers: authHeaders(tenant.id, user.id, 'ADMIN'),
          payload: { input },
        });
        row.httpResponse = { statusCode: http.statusCode, body: http.json() };
        if (http.statusCode === 429 || http.statusCode >= 500) {
          row.classification = 'INFRASTRUCTURE_ERROR';
          row.infrastructure = {
            type: http.statusCode === 429 ? 'RATE_LIMIT' : 'NETWORK',
            retries: interpretedResult.retries,
            finalFailure: true,
          };
          row.notes = `HTTP /ai/execute returned ${http.statusCode}`;
          results.push(row);
          continue;
        }

        row.classification = classify({
          interpreted,
          executionResult: execution,
          expectedNextState: scenario.expectedNextState,
        });
        row.notes = `Expected behavior: ${scenario.expectedBehavior}`;
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
        row.notes = err instanceof Error ? err.message : 'Unknown error';
      }
      results.push(row);
    }

    await app.close();
    await prisma.$disconnect();
    await finalize(environment, results);
  } catch {
    if (strict) throw strictModeError(['DB execution path failed']);
    logger.warn(
      '[strict-mode] DB execution path failed. Falling back to interpreter-only behavior harness.',
    );
    environment.db = 'not_connected';
    await prisma.$disconnect().catch(() => undefined);
    await runInterpreterOnly(interpreter, environment, delayMs, maxRetries);
  }
}

async function runInterpreterOnly(
  interpreter: InterpreterService,
  environment: HarnessEnvironment,
  delayMs: number,
  maxRetries: number,
): Promise<void> {
  const results: ScenarioResult[] = [];
  for (const scenario of AI_BEHAVIOR_SCENARIOS) {
    await delayBeforeScenario(delayMs);
    const input = scenario.input.replaceAll(
      '{{PRACTICE_ID}}',
      '11111111-1111-1111-1111-111111111111',
    );
    const row: ScenarioResult = {
      scenarioId: scenario.id,
      category: scenario.category,
      input,
      classification: 'EXECUTION_ERROR',
      notes: 'Execution skipped: DB unavailable',
    };
    try {
      const interpretedResult = await withRetry(
        () =>
          interpreter.interpret(input, {
            tenantId: '11111111-1111-1111-1111-111111111111',
            userId: '11111111-1111-1111-1111-111111111111',
            practices: [
              {
                id: '11111111-1111-1111-1111-111111111111',
                status: 'CREATED',
                type: 'generic practice',
                summary: 'generic practice',
              },
            ],
          }),
        maxRetries,
      );
      const interpreted = interpretedResult.value;
      row.interpreterOutput = interpreted;
      const normalizerService = new NormalizerService();
      const normalized = normalizerService.normalize(interpreted);
      row.classification =
        scenario.expectedNextState && normalized.nextState !== scenario.expectedNextState
          ? 'WRONG_INTERPRETATION'
          : 'EXECUTION_ERROR';
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
      row.notes = `${row.notes}; ${err instanceof Error ? err.message : String(err)}`;
    }
    results.push(row);
  }
  await finalize(environment, results);
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
  if (err instanceof HarnessInfrastructureError) {
    return { classification: 'INFRASTRUCTURE_ERROR', infrastructure: err.infrastructure };
  }
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
  const base = {
    total: results.length,
    SUCCESS: 0,
    AMBIGUOUS: 0,
    VALIDATION_ERROR: 0,
    EXECUTION_ERROR: 0,
    WRONG_INTERPRETATION: 0,
    INFRASTRUCTURE_ERROR: 0,
  };
  for (const r of results) base[r.classification] += 1;
  return base;
}

async function finalize(environment: HarnessEnvironment, results: ScenarioResult[]): Promise<void> {
  const summary = summarize(results);
  console.log('\nAI BEHAVIOR REPORT\n');
  console.log(`Environment: db=${environment.db}, llm=${environment.llm}`);
  console.log(`Total: ${summary.total}`);
  console.log(`SUCCESS: ${summary.SUCCESS}`);
  console.log(`AMBIGUOUS: ${summary.AMBIGUOUS}`);
  console.log(`VALIDATION_ERROR: ${summary.VALIDATION_ERROR}`);
  console.log(`EXECUTION_ERROR: ${summary.EXECUTION_ERROR}`);
  console.log(`WRONG_INTERPRETATION: ${summary.WRONG_INTERPRETATION}`);
  console.log(`INFRASTRUCTURE_ERROR: ${summary.INFRASTRUCTURE_ERROR}`);

  const failed = results.filter((r) => r.classification !== 'SUCCESS');
  if (failed.length > 0) {
    console.log('\nFAILED CASES:\n');
    for (const f of failed) {
      console.log(`[${f.classification}] ${f.scenarioId}`);
      console.log(`Input: ${f.input}`);
      if (f.interpreterOutput) console.log(`Output: ${JSON.stringify(f.interpreterOutput)}`);
      if (f.infrastructure) console.log(`Infrastructure: ${JSON.stringify(f.infrastructure)}`);
      console.log('');
    }
  }

  await mkdir('reports', { recursive: true });
  await writeFile(
    'reports/ai-behavior-report.json',
    JSON.stringify({ environment, summary, results }, null, 2),
    'utf8',
  );
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

void main().catch(async (err: unknown) => {
  console.error('AI behavior harness runtime error:', err);
  await mkdir('reports', { recursive: true });
  await writeFile(
    'reports/ai-behavior-report.json',
    JSON.stringify(
      {
        environment: { db: 'not_connected', llm: 'stub' },
        summary: {
          total: 0,
          SUCCESS: 0,
          AMBIGUOUS: 0,
          VALIDATION_ERROR: 0,
          EXECUTION_ERROR: 1,
          WRONG_INTERPRETATION: 0,
          INFRASTRUCTURE_ERROR: 0,
        },
        results: [],
        fatal: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
    'utf8',
  );
  if (isStrictMode()) {
    process.exitCode = 1;
  }
});
