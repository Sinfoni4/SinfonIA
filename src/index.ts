import { ContextService } from './ai/context/context.service.js';
import { DecisionEngine } from './ai/decision/decision.engine.js';
import { ExecutorService } from './ai/execution/executor.service.js';
import { InterpreterService } from './ai/interpreter/interpreter.service.js';
import { NormalizerService } from './ai/normalization/normalizer.service.js';
import { createDisabledLLMClient } from './ai/providers/disabled.provider.js';
import {
  createAzureOpenAIProvider,
  createMistralProvider,
  createOpenAIProvider,
} from './ai/providers/openai.provider.js';
import { AITracer } from './ai/tracing/ai.tracer.js';
import {
  validateBeforeDecision,
  validateResolvedCommand,
} from './ai/validation/pre-execution.validator.js';
import { loadConfig } from './config/config.js';
import { createPrismaPrincipalResolver } from './core/authz/authorization.service.js';
import { ComplianceService } from './core/compliance/compliance.service.js';
import { SimulatedEmailSender } from './core/email/email.sender.js';
import { LoginService } from './core/identity/login.service.js';
import { setScheduledExport } from './core/identity/member-access.service.js';
import { ComplianceReminderHandler } from './core/outbox/compliance-reminder.handler.js';
import { OutboxDispatcher } from './core/outbox/outbox.dispatcher.js';
import { PracticeExportHandler } from './core/outbox/practice-export.handler.js';
import { PracticeApplicationService } from './core/practice/practice.application.service.js';
import { SchedulerService } from './core/scheduler/scheduler.service.js';
import { createPrismaClient } from './data/db/prisma.js';
import { AiTraceRepository } from './data/repositories/ai-trace.repository.js';
import { createStorageService } from './data/storage/storage.factory.js';
import { PrismaConversationMemory } from './interface/conversation/conversation.memory.js';
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
import { log } from './shared/log.js';
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

  await httpServer.close();
  httpServer = null;
  log.info('HTTP server closed');
}

export async function disconnectPrismaClient() {
  try {
    if (!prismaClient) return;
    await prismaClient.$disconnect();
  } catch {
    // swallow
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
    | 'MISTRAL_API_KEY'
    | 'MISTRAL_MODEL'
  >,
): LLMClient {
  if (config.ENABLE_LLM && config.LLM_PROVIDER === 'mistral' && config.MISTRAL_API_KEY) {
    return createMistralProvider({ apiKey: config.MISTRAL_API_KEY, model: config.MISTRAL_MODEL });
  }
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
  return createDisabledLLMClient(
    'LLM is disabled via ENABLE_LLM=false or missing the API key of LLM_PROVIDER',
  );
}

// Composition root: wires layers together.
async function main() {
  acquireProcessLock();
  installLifecycleHooks();
  assertProjectRoot();

  const config = loadConfig();
  const logger = createLogger(config);
  const prisma = createPrismaClient(config.DATABASE_URL);
  prismaClient = prisma;

  logger.info({ port: config.PORT }, 'Starting SinfonIA');

  // DB initialization is explicit (`npm run db:setup`) and never runs at app startup.
  const dbConfig = validateDatabaseConfig();

  const connect = await forceDatabaseConnect(prisma);

  const health = await checkDatabaseHealth(prisma);

  const dbOperational = Boolean(dbConfig.valid && connect.ok && health.healthy);
  runtimeState.setDatabaseReachable(dbOperational);

  if (!dbOperational) {
    runtimeMode = 'DEGRADED';
    runtimeState.setMode('DEGRADED');
    if (process.env.NODE_ENV === 'production') {
      logger.fatal('Cannot start: database unreachable (production safety)');
      process.exit(1);
    }
    logger.warn('Database offline: starting in degraded development mode');
  } else {
    runtimeMode = 'HEALTHY';
    runtimeState.setMode('HEALTHY');
    logger.info('Database connection established');
  }

  logger.info({ runtime: runtimeState.snapshot() }, 'Runtime initialized');

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

  // Conversation memory (last practice, welcome shown) is kept in the database.
  const conversationMemory = new PrismaConversationMemory(prisma);

  // Natural-language messages from any chat channel go through the same AI pipeline.
  const chatAdapter = new TelegramAdapter({
    memory: conversationMemory,
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
    scheduledExport: (orgId: string, userId: string, enabled: boolean) =>
      setScheduledExport(prisma, orgId, userId, enabled, { userId }),
    memory: conversationMemory,
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
    principals: createPrismaPrincipalResolver(prisma),
    prisma,
    // Email login (MF6): only where enabled, never in production until a provider exists (D11).
    ...(config.AUTH_EMAIL_LOGIN
      ? {
          login: new LoginService(prisma, new SimulatedEmailSender(), config.AUTH_SECRET, {
            log: logger,
            exposeCodes: config.AUTH_DEV_SHOW_CODE,
          }),
        }
      : {}),
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

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken && tgToken.trim().length > 0) {
    const bot = new TelegramBotService(conversationDeps);
    bot.start(tgToken);
  } else {
    logger.info('Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)');
  }

  // HTTP transport is optional during hot-reload/degraded runtime.
  void (async () => {
    await app.ready();
    await listenWithRetry(app.server, config.PORT);
    logger.info({ port: config.PORT }, 'HTTP server listening');
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
}

main().catch((err: unknown) => {
  // Fail fast. In enterprise environments, a partial boot is worse than a crash.
  log.fatal({ error: errorLabel(err) }, 'SinfonIA failed to start');
  process.exitCode = 1;
});
