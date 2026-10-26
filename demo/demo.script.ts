import dotenv from 'dotenv';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { createOpenAIProvider } from '../src/ai/providers/openai.provider.js';
import { createDeterministicStubLLM } from '../src/ai/providers/stub.provider.js';
import { enforceIdPriority } from '../src/ai/validation/pre-execution.validator.js';
import { InMemoryPracticeRepository } from '../src/domain/practice.repository.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeWorkflow } from '../src/core/workflow/practice.workflow.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

dotenv.config({ path: '.env.test' });

async function main() {
  const config = loadConfig();
  const logger = createLogger({ ...config, SERVICE_NAME: 'sinfonia-demo' });
  const prisma = createPrismaClient(config.DATABASE_URL);
  await prisma.$connect();

  const llm =
    config.ENABLE_LLM && config.OPENAI_API_KEY
      ? createOpenAIProvider({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL })
      : createDeterministicStubLLM();

  const interpreterService = new InterpreterService({ llm, log: logger });
  const normalizerService = new NormalizerService();
  const decisionEngine = new DecisionEngine();
  const practiceWorkflow = new PracticeWorkflow(prisma);
  const artistPracticeRepo = new InMemoryPracticeRepository();
  const executorService = new ExecutorService({ practiceWorkflow, artistPracticeRepo });
  const contextService = new ContextService(prisma, artistPracticeRepo);

  const app = buildServer(config, logger, {
    practiceWorkflow,
    interpreterService,
    executorService,
    contextService,
    decisionEngine,
    normalizerService,
  });

  async function run(input: string) {
    const interpreted = await interpreterService.interpret(input, {
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: '11111111-1111-1111-1111-111111111111',
      practices: (await contextService.getPracticeContext('11111111-1111-1111-1111-111111111111', null)).practices,
    });
    const normalized = enforceIdPriority(normalizerService.normalize(interpreted));

    // Minimal router: create_practice bypasses DecisionEngine.
    const cmd =
      normalized.action === 'create_practice'
        ? { action: 'create_practice', data: { artistName: normalized.artistName } }
        : decisionEngine.resolveCommand(normalized, {
            tenantId: '11111111-1111-1111-1111-111111111111',
            userId: '11111111-1111-1111-1111-111111111111',
            practices: (await contextService.getPracticeContext('11111111-1111-1111-1111-111111111111', null)).practices,
          });

    const result = await executorService.execute(cmd, { tenantId: '11111111-1111-1111-1111-111111111111', userId: null });
    console.log('[DEMO]', { input, output: { interpreted, normalized, cmd, result } });
    return result;
  }

  const flow = [
    'crea pratica per Mario Rossi',
    'valida la pratica di Mario Rossi',
    'completa la pratica di Mario Rossi',
  ];

  for (const step of flow) {
    console.log('\n[DEMO] step', { command: step });
    await run(step);
  }

  await app.close();
  await prisma.$disconnect();
}

void main().catch((err: unknown) => {
  console.error('[DEMO] fatal', err);
  process.exitCode = 1;
});

