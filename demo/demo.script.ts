import dotenv from 'dotenv';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { createOpenAIProvider } from '../src/ai/providers/openai.provider.js';
import { createDeterministicStubLLM } from '../src/ai/providers/stub.provider.js';
import { enforceIdPriority } from '../src/ai/validation/pre-execution.validator.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
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
  const practiceService = new PracticeApplicationService(prisma);
  const executorService = new ExecutorService({ practiceService });
  const contextService = new ContextService(practiceService);

  const tenant = await new TenantRepository(prisma).createTenant({ name: 'sinfonia-demo' });
  const user = await new UserRepository(prisma).createUser(tenant.id, {
    email: `demo-${tenant.id}@test.local`,
    role: 'OPERATOR',
  });
  const context = { tenantId: tenant.id, userId: user.id };

  async function run(input: string) {
    const practices = (await contextService.getPracticeContext(tenant.id, user.id)).practices;
    const interpreted = await interpreterService.interpret(input, { ...context, practices });
    const normalized = enforceIdPriority(normalizerService.normalize(interpreted));

    // Minimal router: create_practice bypasses DecisionEngine.
    const cmd =
      normalized.action === 'create_practice'
        ? { action: 'create_practice', data: { artistName: normalized.artistName } }
        : decisionEngine.resolveCommand(normalized, {
            ...context,
            practices: (await contextService.getPracticeContext(tenant.id, user.id)).practices,
          });

    const result = await executorService.execute(cmd, context);
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

  await prisma.$disconnect();
}

void main().catch((err: unknown) => {
  console.error('[DEMO] fatal', err);
  process.exitCode = 1;
});
