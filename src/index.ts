import 'dotenv/config';

import { ContextService } from './ai/context/context.service.js';
import { DecisionEngine } from './ai/decision/decision.engine.js';
import { ExecutorService } from './ai/execution/executor.service.js';
import { InterpreterService } from './ai/interpreter/interpreter.service.js';
import { NormalizerService } from './ai/normalization/normalizer.service.js';
import { createDisabledLLMClient } from './ai/providers/disabled.provider.js';
import { createAzureOpenAIProvider, createOpenAIProvider } from './ai/providers/openai.provider.js';
import { AITracer } from './ai/tracing/ai.tracer.js';
import {
  validateBeforeDecision,
  validateResolvedCommand,
} from './ai/validation/pre-execution.validator.js';
import { loadConfig } from './config/config.js';
import { ComplianceService } from './core/compliance/compliance.service.js';
import { ComplianceReminderHandler } from './core/outbox/compliance-reminder.handler.js';
import { OutboxDispatcher } from './core/outbox/outbox.dispatcher.js';
import { PracticeExportHandler } from './core/outbox/practice-export.handler.js';
import { PracticeApplicationService } from './core/practice/practice.application.service.js';
import { SchedulerService } from './core/scheduler/scheduler.service.js';
import { createPrismaClient } from './data/db/prisma.js';
import { AiTraceRepository } from './data/repositories/ai-trace.repository.js';
import { createStorageService } from './data/storage/storage.factory.js';
import { printRuntimeTestGuide } from './dev/dev.tests.js';
import { buildServer } from './interface/http/server.js';
import { TelegramAdapter } from './interface/telegram/telegram.adapter.js';
import { TelegramBotService } from './interface/telegram/telegram.bot.js';
import { TelegramClient } from './interface/telegram/telegram.client.js';
import { formatTelegramResponse } from './interface/telegram/telegram.formatter.js';
import { createTelegramNotifier } from './interface/telegram/telegram.notifier.js';
import { createWebhookNotifier } from './interface/webhook/webhook.notifier.js';
import { WhatsAppChannel } from './interface/whatsapp/whatsapp.channel.js';
import { WhatsAppClient } from './interface/whatsapp/whatsapp.client.js';
import { createWhatsAppNotifier } from './interface/whatsapp/whatsapp.notifier.js';
import { validateDatabaseConfig } from './runtime/runtime.db.config.js';
import { forceDatabaseConnect } from './runtime/runtime.db.connect.js';
import { checkDatabaseHealth } from './runtime/runtime.db.health.js';
import { startDbWatcher } from './runtime/runtime.dbWatcher.js';
import { installLifecycleHooks } from './runtime/runtime.lifecycle.js';
import { listenWithRetry } from './runtime/runtime.port.js';
import { acquireProcessLock } from './runtime/runtime.processLock.js';
import { runtimeState } from './runtime/runtime.state.js';
import { startBackgroundWorkers } from './runtime/runtime.workers.js';
import { errorLabel } from './shared/errors.js';
import { createLogger } from './shared/logger.js';
import { assertProjectRoot } from './shared/project-root.js';

import type { LLMClient } from './ai/interpreter/interpreter.service.js';
import type { AppConfig } from './config/config.js';
import type { ConversationIdentity } from './interface/conversation/conversation.service.js';

export let runtimeMode: 'HEALTHY' | 'DEGRADED' | 'CIRCUIT_OPEN' = 'HEALTHY';
let httpServer: ReturnType<typeof buildServer> | null = null;
let prismaClient: ReturnType<typeof createPrismaClient> | null = null;

export async function shutdownHttpServer() {
  if (!httpServer) return;

  console.log('🛑 Closing HTTP server...');
  await httpServer.close();
  httpServer = null;
  console.log('✅ HTTP server closed');
}

export async function disconnectPrismaClient() {
  try {
    if (!prismaClient) return;
    await prismaClient.$disconnect();
  } catch {
    // swallow
  }
}

function assertEnv() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set → bot disabled');
  } else {
    console.log('✅ TELEGRAM_BOT_TOKEN detected');
  }
}

function createLLMClient(
  config: Pick<
    AppConfig,
    | 'OPENAI_API_KEY'
    | 'ENABLE_LLM'
    | 'OPENAI_MODEL'
    | 'LLM_PROVIDER'
    | 'AZURE_OPENAI_ENDPOINT'
    | 'AZURE_OPENAI_API_KEY'
    | 'AZURE_OPENAI_DEPLOYMENT'
    | 'AZURE_OPENAI_API_VERSION'
  >,
): LLMClient {
  if (
    config.ENABLE_LLM &&
    config.LLM_PROVIDER === 'azure' &&
    config.AZURE_OPENAI_ENDPOINT &&
    config.AZURE_OPENAI_API_KEY &&
    config.AZURE_OPENAI_DEPLOYMENT
  ) {
    return createAzureOpenAIProvider({
      endpoint: config.AZURE_OPENAI_ENDPOINT,
      apiKey: config.AZURE_OPENAI_API_KEY,
      deployment: config.AZURE_OPENAI_DEPLOYMENT,
      apiVersion: config.AZURE_OPENAI_API_VERSION,
    });
  }
  if (config.ENABLE_LLM && config.OPENAI_API_KEY) {
    return createOpenAIProvider({
      apiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_MODEL,
    });
  }
  return createDisabledLLMClient('LLM is disabled via ENABLE_LLM=false or missing OPENAI_API_KEY');
}

function getRuntimeSnapshot() {
  return runtimeState.snapshot();
}

// Composition root: wires layers together.
async function main() {
  console.log('BOOTSTEP 1 — main() entered');
  acquireProcessLock();
  installLifecycleHooks();
  console.log('🌱 ENV loaded — DATABASE_URL present:', !!process.env.DATABASE_URL);
  assertProjectRoot();
  assertEnv();

  if (process.env.NODE_ENV !== 'production') {
    console.log('🔁 Dev mode active — hot reload enabled');
  }

  const config = loadConfig();
  const logger = createLogger(config);
  const prisma = createPrismaClient(config.DATABASE_URL);
  prismaClient = prisma;

  logger.info({ port: config.PORT }, 'Starting SinfonIA');

  // DB initialization is explicit (`npm run db:setup`) and never runs at app startup.
  const dbConfig = validateDatabaseConfig();

  console.log('🔌 DB CONNECT — attempting initial connection');
  const connect = await forceDatabaseConnect(prisma);

  const health = await checkDatabaseHealth(prisma);

  const dbOperational = Boolean(dbConfig.valid && connect.ok && health.healthy);
  runtimeState.setDatabaseReachable(dbOperational);

  if (!dbOperational) {
    runtimeMode = 'DEGRADED';
    runtimeState.setMode('DEGRADED');
    if (process.env.NODE_ENV === 'production') {
      console.error('💥 Cannot start: database unreachable (production safety)');
      process.exit(1);
    }
    console.warn('⚠️ Database offline — starting in DEGRADED DEV MODE');
  } else {
    runtimeMode = 'HEALTHY';
    runtimeState.setMode('HEALTHY');
    logger.info('Database connection established');
  }

  console.log('BOOTSTEP 2 — DB health completed');
  console.log('BOOTSTEP 3 — runtime initialized');
  console.log('RUNTIME SNAPSHOT', getRuntimeSnapshot());

  if (process.env.NODE_ENV !== 'production') {
    console.log(`🧭 Runtime mode: ${runtimeMode}`);
    printRuntimeTestGuide();
    console.log(`
=========== PHASE 5 TEST GUIDE ===========
TEST 1 — Healthy baseline
TEST 2 — Slow DB (simulate delay)
TEST 3 — DB shutdown → circuit opens
TEST 4 — DB restart → auto recovery
TEST 5 — /devstate health metrics
`);
  }

  const llm = createLLMClient(config);
  const interpreterService = new InterpreterService({
    llm,
    log: config.NODE_ENV === 'development' ? logger : undefined,
  });
  const practiceService = new PracticeApplicationService(prisma, {
    maxAttachmentBytes: config.ATTACHMENT_MAX_BYTES,
    storageService: createStorageService(config),
  });
  const executorService = new ExecutorService({ practiceService });
  const contextService = new ContextService(practiceService);
  const decisionEngine = new DecisionEngine();
  const normalizerService = new NormalizerService();
  const complianceService = new ComplianceService(prisma);

  // Natural-language messages from any chat channel go through the same AI pipeline.
  const chatAdapter = new TelegramAdapter({
    interpreter: interpreterService,
    normalizer: normalizerService,
    decisionEngine,
    validateBeforeDecision,
    validateResolvedCommand,
    executor: executorService,
    contextService,
    formatResponse: formatTelegramResponse,
  });
  const conversationDeps = {
    prisma,
    practiceService,
    complianceService,
    handleMessage: (input: string, identity: ConversationIdentity) =>
      chatAdapter.handleMessage(input, identity),
    log: logger,
  };

  const whatsappClient =
    config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID
      ? new WhatsAppClient({
          accessToken: config.WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
          apiVersion: config.WHATSAPP_API_VERSION,
        })
      : null;
  const whatsappChannel = whatsappClient
    ? new WhatsAppChannel(whatsappClient, conversationDeps, logger)
    : null;
  logger.info(
    { enabled: Boolean(whatsappChannel) },
    whatsappChannel ? 'WhatsApp channel enabled' : 'WhatsApp channel disabled (WHATSAPP_* not set)',
  );

  // AI traces are kept in memory and persisted, so they survive restarts.
  const aiTraceRepository = new AiTraceRepository(prisma);
  const tracer = new AITracer(200, { store: aiTraceRepository, log: logger });

  const app = buildServer(config, logger, {
    practiceService,
    complianceService,
    tracer,
    ...(whatsappChannel && config.WHATSAPP_APP_SECRET && config.WHATSAPP_VERIFY_TOKEN
      ? {
          whatsappWebhook: {
            verifyToken: config.WHATSAPP_VERIFY_TOKEN,
            appSecret: config.WHATSAPP_APP_SECRET,
            onPayload: (payload: unknown) => whatsappChannel.receive(payload),
          },
        }
      : {}),
    interpreterService,
    executorService,
    contextService,
    decisionEngine,
    normalizerService,
  });
  httpServer = app;

  console.log('🚀 TELEGRAM BOOTSTRAP START');
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken && tgToken.trim().length > 0) {
    const bot = new TelegramBotService(conversationDeps);
    bot.start(tgToken);
  } else {
    logger.info('Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)');
  }
  console.log('✅ TELEGRAM BOOTSTRAP COMPLETE');

  console.log('⚠️ HTTP bind async started');
  // HTTP transport is optional during hot-reload/degraded runtime.
  void (async () => {
    await app.ready();
    console.log('BOOTSTEP 4 — starting HTTP bind');
    await listenWithRetry(app.server, config.PORT);
    console.log('BOOTSTEP 5 — HTTP bind success');
    logger.info('HTTP server listening');
  })().catch((err) => {
    logger.error({ error: errorLabel(err) }, 'HTTP bind failed (async)');
  });

  // Self-healing: periodically re-check DB and recover runtime mode.
  startDbWatcher(prisma);

  // Durable scheduler and outbox delivery, each on its own interval.
  if (!config.OUTBOX_WEBHOOK_SECRET) {
    logger.warn('OUTBOX_WEBHOOK_SECRET not set: tenant webhooks will be dead-lettered');
  }
  const schedulerService = new SchedulerService(prisma, practiceService, { complianceService });
  const outboxChannels = {
    ...(tgToken?.trim()
      ? { telegram: createTelegramNotifier(new TelegramClient(tgToken.trim())) }
      : {}),
    ...(config.OUTBOX_WEBHOOK_SECRET
      ? {
          webhook: createWebhookNotifier({
            secret: config.OUTBOX_WEBHOOK_SECRET,
            allowInsecureHttp: config.NODE_ENV !== 'production',
            allowPrivateNetwork: config.NODE_ENV !== 'production',
          }),
        }
      : {}),
    ...(whatsappClient ? { whatsapp: createWhatsAppNotifier(whatsappClient) } : {}),
  };
  const dispatcher = new OutboxDispatcher(prisma, {
    maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
    log: logger,
    handlers: [
      new PracticeExportHandler(prisma, outboxChannels),
      new ComplianceReminderHandler(prisma, outboxChannels),
    ],
  });
  startBackgroundWorkers(
    [
      {
        name: 'scheduler',
        intervalMs: config.SCHEDULER_INTERVAL_MS,
        run: () => schedulerService.tick(),
      },
      {
        name: 'ai-trace-retention',
        intervalMs: 60 * 60_000,
        run: async () => ({
          deleted: await aiTraceRepository.deleteOlderThan(
            new Date(Date.now() - config.AI_TRACE_RETENTION_DAYS * 86_400_000),
          ),
        }),
      },
      {
        name: 'outbox',
        intervalMs: config.OUTBOX_DISPATCH_INTERVAL_MS,
        run: () => dispatcher.dispatchOnce(),
      },
    ],
    logger,
  );

  console.log('BOOTSTEP 6 — starting Telegram bootstrap');
  console.log('BOOTSTEP 7 — Telegram bootstrap completed');
}

main().catch((err: unknown) => {
  // Fail fast. In enterprise environments, a partial boot is worse than a crash.
  console.error(errorLabel(err));
  process.exitCode = 1;
});
