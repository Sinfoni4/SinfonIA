import { ContextService } from './ai/context/context.service.js';
import { DecisionEngine } from './ai/decision/decision.engine.js';
import { ExecutorService } from './ai/execution/executor.service.js';
import { InterpreterService } from './ai/interpreter/interpreter.service.js';
import { NormalizerService } from './ai/normalization/normalizer.service.js';
import { defaultDocumentOcrService } from './ai/ocr/document-ocr.service.js';
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
import { requestAssistance } from './core/assistance/assistance.service.js';
import {
  createPrismaPrincipalResolver,
  type Principal,
} from './core/authz/authorization.service.js';
import { ComplianceService } from './core/compliance/compliance.service.js';
import { GrantExpiringHandler } from './core/delegation/grant-reminders.js';
import { expireDemoAccounts, startDemo } from './core/demo/demo-access.js';
import { SimulatedEmailSender } from './core/email/email.sender.js';
import { ChannelLinkService } from './core/identity/channel-link.service.js';
import { LoginService } from './core/identity/login.service.js';
import { setScheduledExport } from './core/identity/member-access.service.js';
import {
  getCompanyCard,
  revealCompanyIdentifiers,
} from './core/organization/company-card.service.js';
import {
  AssistanceRequestedHandler,
  AssistanceUpdatedHandler,
} from './core/outbox/assistance.handler.js';
import {
  AttachmentOcrHandler,
  AttachmentReadHandler,
} from './core/outbox/attachment-ocr.handler.js';
import { ComplianceReminderHandler } from './core/outbox/compliance-reminder.handler.js';
import { OutboxDispatcher } from './core/outbox/outbox.dispatcher.js';
import { PracticeExportHandler } from './core/outbox/practice-export.handler.js';
import {
  AttachmentRejectedHandler,
  DocumentRequestedHandler,
  DocumentRequestFulfilledHandler,
  PracticeAssignedHandler,
  PracticeHolderSetHandler,
  PracticeStatusHandler,
} from './core/outbox/practice-status.handler.js';
import { confirmReadDocument } from './core/practice/attachment-validation.js';
import { practicesWithOpenRequests } from './core/practice/document-request.js';
import { moduleOfTenant } from './core/practice/practice-module.js';
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
import { ALL_INTERFACES, listenWithRetry } from './runtime/runtime.port.js';
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
  const storageService = createStorageService(config);
  const practiceService = new PracticeApplicationService(prisma, {
    maxAttachmentBytes: config.ATTACHMENT_MAX_BYTES,
    storageService,
  });
  const executorService = new ExecutorService({ practiceService });
  // A02: the AI gets the sector instructions of the organization's module.
  const contextService = new ContextService(
    practiceService,
    async (tenantId) => (await moduleOfTenant(prisma, tenantId)).aiInstructions,
  );
  const decisionEngine = new DecisionEngine();
  const normalizerService = new NormalizerService();
  const complianceService = new ComplianceService(prisma);

  // Conversation memory (last practice, welcome shown) is kept in the database.
  const conversationMemory = new PrismaConversationMemory(prisma);

  // Natural-language messages from any chat channel go through the same AI pipeline.
  // AI traces are kept in memory and persisted, so they survive restarts.
  const aiTraceRepository = new AiTraceRepository(prisma);
  const tracer = new AITracer(200, { store: aiTraceRepository, log: logger });

  const chatAdapter = new TelegramAdapter({
    memory: conversationMemory,
    // S08: the AI calls from the chat are traced too (they were not before).
    tracer,
    interpreter: interpreterService,
    normalizer: normalizerService,
    decisionEngine,
    validateBeforeDecision,
    validateResolvedCommand,
    executor: executorService,
    contextService,
    formatResponse: formatTelegramResponse,
  });
  // MF6 and AGX-10: email login and the verified chat link share the (simulated) email sender;
  // both exist only where email login is on, never in production until a provider exists (D11).
  const emailSender = new SimulatedEmailSender();
  const channelLinks = config.AUTH_EMAIL_LOGIN
    ? new ChannelLinkService(prisma, emailSender, config.AUTH_SECRET, {
        exposeCodes: config.AUTH_DEV_SHOW_CODE,
        log: logger,
      })
    : undefined;
  // Demo (staging only): an account of one's own in «SinfonIA Demo» from «/start demo».
  const demoAccess = config.DEMO_ACCESS
    ? (telegramId: string) =>
        startDemo({ prisma, practices: practiceService, compliance: complianceService }, telegramId)
    : undefined;
  const conversationDeps = {
    prisma,
    ...(demoAccess ? { demoAccess } : {}),
    ...(channelLinks ? { channelLinks } : {}),
    // A2: «Modifica» under a document points to the dashboard page of the documents to verify.
    ...(config.WEB_PUBLIC_URL ? { reviewUrl: `${config.WEB_PUBLIC_URL}/app/verifica` } : {}),
    // Telegram Mini App: offered in chat only when on and reachable over https.
    ...(config.TELEGRAM_MINIAPP && config.WEB_PUBLIC_URL?.startsWith('https://')
      ? { miniAppUrl: `${config.WEB_PUBLIC_URL}/app/tg` }
      : {}),
    scheduledExport: (orgId: string, userId: string, enabled: boolean) =>
      setScheduledExport(prisma, orgId, userId, enabled, { userId }),
    // A1: «conferma» in chat confirms the data of one's own document as read.
    confirmDocument: (input: {
      tenantId: string;
      userId: string;
      practiceId: string;
      attachmentId: string;
    }) => confirmReadDocument(prisma, input),
    // H10: «parla con un operatore» records a request for the dashboard and tells the operators.
    requestAssistance: (input: Parameters<typeof requestAssistance>[1]) =>
      requestAssistance(prisma, input),
    // AGX-12a: «🏢 La mia azienda» in chat; the full codes only to who manages it, audited.
    companyCard: (actor: Principal) => getCompanyCard(prisma, complianceService, actor),
    practicesWithOpenRequests: (input: { tenantId: string; userId: string }) =>
      practicesWithOpenRequests(prisma, input),
    revealCompanyIdentifiers: (actor: Principal, channel: string) =>
      revealCompanyIdentifiers(prisma, actor, channel),
    memory: conversationMemory,
    practiceService,
    complianceService,
    handleMessage: (input: string, identity: ConversationIdentity) =>
      chatAdapter.answer(input, identity),
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

  const app = buildServer(config, logger, {
    principals: createPrismaPrincipalResolver(prisma),
    prisma,
    // Email login (MF6): only where enabled, never in production until a provider exists (D11).
    // Telegram Mini App: sessions without email login (no email routes, no console then).
    emailLogin: config.AUTH_EMAIL_LOGIN,
    ...(config.AUTH_EMAIL_LOGIN ||
    (config.TELEGRAM_MINIAPP && process.env.TELEGRAM_BOT_TOKEN?.trim())
      ? {
          login: new LoginService(prisma, emailSender, config.AUTH_SECRET, {
            log: logger,
            exposeCodes: config.AUTH_DEV_SHOW_CODE,
            webUrl: config.WEB_PUBLIC_URL,
          }),
        }
      : {}),
    ...(channelLinks ? { channelLinks } : {}),
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
    // Login codes on screen: anyone who reaches the page could log in as anyone invited, so the
    // page is reachable from this PC only, never from the local network.
    const host = config.HOST ?? (config.AUTH_DEV_SHOW_CODE ? '127.0.0.1' : ALL_INTERFACES);
    await listenWithRetry(app.server, config.PORT, host);
    logger.info({ port: config.PORT, host }, 'HTTP server listening');
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
      // A3 and H10: chat notices of practice states and of assistance requests.
      new PracticeStatusHandler(prisma, outboxChannels),
      new AssistanceRequestedHandler(
        prisma,
        outboxChannels,
        config.WEB_PUBLIC_URL ? `${config.WEB_PUBLIC_URL}/app/assistenza` : undefined,
      ),
      new AssistanceUpdatedHandler(prisma, outboxChannels),
      new GrantExpiringHandler(
        prisma,
        outboxChannels,
        config.WEB_PUBLIC_URL ? `${config.WEB_PUBLIC_URL}/app/deleghe` : undefined,
      ),
      new PracticeAssignedHandler(
        prisma,
        outboxChannels,
        config.WEB_PUBLIC_URL ? `${config.WEB_PUBLIC_URL}/app` : undefined,
      ),
      new AttachmentRejectedHandler(prisma, outboxChannels),
      // AGX-08: a document whose first read failed is read again, then the sender is told.
      new AttachmentOcrHandler(prisma, {
        ocrService: defaultDocumentOcrService,
        storageService,
        maxAttempts: Math.min(config.OCR_MAX_ATTEMPTS, config.OUTBOX_MAX_ATTEMPTS),
      }),
      new AttachmentReadHandler(prisma, outboxChannels),
      new DocumentRequestedHandler(prisma, outboxChannels),
      new DocumentRequestFulfilledHandler(
        prisma,
        outboxChannels,
        config.WEB_PUBLIC_URL ? `${config.WEB_PUBLIC_URL}/app` : undefined,
      ),
      new PracticeHolderSetHandler(
        prisma,
        outboxChannels,
        config.WEB_PUBLIC_URL ? `${config.WEB_PUBLIC_URL}/app` : undefined,
      ),
    ],
  });
  startBackgroundWorkers(
    [
      {
        name: 'scheduler',
        intervalMs: config.SCHEDULER_INTERVAL_MS,
        run: () => schedulerService.tick(),
      },
      ...(config.DEMO_ACCESS
        ? [
            {
              name: 'demo-expiry',
              intervalMs: 60 * 60_000,
              run: async () => ({ deleted: await expireDemoAccounts(prisma, storageService) }),
            },
          ]
        : []),
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
