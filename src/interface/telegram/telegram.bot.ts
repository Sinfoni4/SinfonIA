import { enrichWithAI } from '../../ai/module.enricher.js';
import { aiSuggestModule } from '../../ai/module.router.ai.js';
import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { bindUserToTenant, getTenantIdByInvite } from '../../core/tenant/tenant.invite.store.js';
import { getTenantByTelegramUserAsync } from '../../core/tenant/tenant.store.js';
import { UserRepository } from '../../data/repositories/user.repository.js';
import { routeModulesForTenant } from '../../modules/module.router.js';
import { errorLabel } from '../../shared/errors.js';

import { handleDevState } from './commands/devstate.command.js';
import { TelegramClient } from './telegram.client.js';
import { mapTelegramErrorToMessage } from './telegram.errors.js';
import {
  hasSeenUser,
  markUserSeen,
  resetTelegramMemory,
  getTelegramMemoryState,
} from './telegram.memory.js';
import { runtimeAwareExecute } from './telegram.runtimeAware.js';
import { safeReply } from './telegram.transport.js';

import type { DomainContext } from '../../modules/domain.module.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const MODULE_TAKEOVER_ENABLED = true;

export type TelegramIdentity = {
  tenantId: string;
  userId: string;
  role: UserRole;
};

type BotDeps = {
  prisma: PrismaClient;
  handleMessage: (input: string, identity: TelegramIdentity) => Promise<string>;
  log?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

let botInstance: TelegramClient | null = null;
let pollingActive = false;

async function shutdownTelegram() {
  try {
    if (botInstance && pollingActive) {
      await botInstance.stopPolling();
      pollingActive = false;
    }
  } catch (err) {
    console.error('Shutdown polling error', errorLabel(err));
  }
}

export async function stopTelegramPollingForRestart() {
  await shutdownTelegram();
}

process.once('SIGINT', () => {
  void shutdownTelegram();
});
process.once('SIGTERM', () => {
  void shutdownTelegram();
});
process.once('beforeExit', () => {
  void shutdownTelegram();
});

function isGreeting(text: string): boolean {
  const t = text.toLowerCase().trim();

  if (t.startsWith('/')) return true;

  return ['ciao', 'hello', 'hi', 'help', 'start'].includes(t);
}

function onboardingMessage(role: UserRole): string {
  if (role === 'ADMIN' || role === 'OPERATOR') {
    return `👋 Ciao! Ti aiuto a gestire le pratiche.

Puoi:
• validarle
• completarle
• controllarne lo stato

Prova a scrivere:
"valida la pratica di Mario Rossi"`;
  }

  return `👋 Ciao! Ti aiuto a gestire le tue pratiche.

Puoi:
• creare una pratica
• controllare lo stato
• chiedere aggiornamenti

Prova a scrivere:
"crea pratica per Mario Rossi"`;
}

function attachMessageHandler(bot: TelegramClient, deps: BotDeps): void {
  bot.on('message', async (msg) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const text = msg.text;
    const chatId = msg.chat.id;
    if (!text || !msg.from || msg.from.is_bot) return;

    // Identity is the Telegram user, never the chat/group id. This prevents
    // every member of a group from sharing the same tenant identity.
    const telegramId = String(msg.from.id);
    let responseSent = false;

    try {
      const trimmed = text.trim();

      let aiSuggestion: string | null = null;
      try {
        aiSuggestion = aiSuggestModule(trimmed);
      } catch (err) {
        deps.log?.error({ error: errorLabel(err), requestId }, 'Telegram AI router error');
      }

      const lower = trimmed.toLowerCase();
      if (trimmed.startsWith('/start')) {
        const parts = trimmed.split(/\s+/);
        const inviteCode = parts[1];

        if (inviteCode) {
          const tenantId = await getTenantIdByInvite(deps.prisma, inviteCode);

          if (!tenantId) {
            await bot.sendMessage(chatId, 'Codice invito non valido');
            return;
          }

          const user = await new UserRepository(deps.prisma).ensureTelegramUser(
            tenantId,
            telegramId,
          );
          await bindUserToTenant(deps.prisma, user.id, tenantId);

          deps.log?.info({ tenantId, requestId }, 'Telegram user linked to tenant');
          await bot.sendMessage(chatId, '🎵 Benvenuto! Sei stato collegato alla tua cooperativa.');

          return;
        }
      }

      let identity: Awaited<ReturnType<typeof getTenantByTelegramUserAsync>>;
      try {
        identity = await getTenantByTelegramUserAsync(deps.prisma, telegramId);
      } catch (err: unknown) {
        if (err instanceof TenantNotLinkedError) {
          await bot.sendMessage(
            chatId,
            'Il tuo account non è ancora collegato a una cooperativa.\nUsa `/start <codice invito>`.',
          );
          return;
        }
        throw err;
      }

      const tenant = identity.tenant;
      const dbUser = { id: identity.userId, role: identity.role };
      const routing = routeModulesForTenant(trimmed, tenant.module);

      if (aiSuggestion) {
        deps.log?.info(
          { requestId, aiSuggestion, tenantModule: tenant.module },
          'Telegram module suggestion',
        );
      }

      let moduleHandled = false;

      if (routing.length === 1) {
        const match = routing[0];

        if (match.module === 'music') {
          let result: unknown;
          let domainContext: DomainContext | undefined;
          try {
            const execContext = {
              tenantId: tenant.id,
              userId: dbUser.id,
              integrationType: tenant.integration.type,
            };

            try {
              domainContext = await match.instance.getContext(execContext);
            } catch (err) {
              deps.log?.error(
                { error: errorLabel(err), requestId, module: match.module },
                'Telegram context failed',
              );
            }

            result = await match.instance.execute(match.command, execContext, domainContext);
          } catch (err) {
            deps.log?.error(
              { error: errorLabel(err), requestId, module: match.module },
              'Telegram module failed',
            );
          }

          if (
            result &&
            typeof result === 'object' &&
            'message' in result &&
            typeof result.message === 'string'
          ) {
            let finalMessage = result.message;

            try {
              finalMessage = await enrichWithAI({
                userInput: trimmed,
                moduleName: match.module,
                baseMessage: result.message,
                domainContext,
              });
            } catch (err) {
              deps.log?.error(
                { error: errorLabel(err), requestId },
                'Telegram AI enrichment failed',
              );
            }

            await bot.sendMessage(chatId, finalMessage);
            responseSent = true;
            moduleHandled = true;
          } else {
            deps.log?.error(
              { requestId, module: match.module },
              'Telegram module invalid response',
            );
          }
        }
      }

      if (responseSent && !MODULE_TAKEOVER_ENABLED) {
        deps.log?.info({ requestId }, 'Telegram response without takeover');
      }

      if (moduleHandled && MODULE_TAKEOVER_ENABLED) {
        return;
      }

      if (lower === '/devstate') {
        if (process.env.NODE_ENV !== 'development') {
          return;
        }

        await runtimeAwareExecute(
          { reply: async (replyText: string) => bot.sendMessage(chatId, replyText) },
          async () => {
            await handleDevState({
              reply: async (runtimeReport) => {
                const memory = getTelegramMemoryState();
                const report = `${runtimeReport}

Memory:
- seen users: ${memory.seenUsersCount}
- memory entries: ${memory.memoryEntries}`;
                await bot.sendMessage(chatId, report);
              },
            });
          },
        );
        return;
      }

      if (lower === '/devreset') {
        if (process.env.NODE_ENV !== 'development') {
          return;
        }

        await runtimeAwareExecute(
          { reply: async (replyText: string) => bot.sendMessage(chatId, replyText) },
          async () => {
            resetTelegramMemory();
            await bot.sendMessage(chatId, '🧹 Dev state reset complete.');
          },
        );
        return;
      }

      if (lower.startsWith('/start')) {
        await runtimeAwareExecute(
          { reply: async (replyText: string) => bot.sendMessage(chatId, replyText) },
          async () => {
            if (!hasSeenUser(telegramId)) {
              markUserSeen(telegramId);
              await bot.sendMessage(chatId, onboardingMessage(dbUser.role));
            } else {
              await bot.sendMessage(chatId, '👋 Bentornato! Come posso aiutarti?');
            }
          },
        );
        return;
      }

      if (isGreeting(text)) {
        if (!hasSeenUser(telegramId)) {
          markUserSeen(telegramId);
          await bot.sendMessage(chatId, onboardingMessage(dbUser.role));
        } else {
          await bot.sendMessage(chatId, '👋 Bentornato! Come posso aiutarti?');
        }
        return;
      }

      // Defensive layer: never let any Telegram command reach the AI pipeline.
      if (trimmed.startsWith('/')) {
        await bot.sendMessage(chatId, onboardingMessage(dbUser.role));
        return;
      }

      const response = await deps.handleMessage(text, {
        tenantId: tenant.id,
        userId: dbUser.id,
        role: dbUser.role,
      });
      if (responseSent) {
        deps.log?.info({ requestId }, 'Telegram double response blocked');
      }
      await bot.sendMessage(chatId, response);
    } catch (err) {
      deps.log?.error({ error: errorLabel(err), requestId }, 'Telegram handler error');

      let replyText: string;
      try {
        replyText = mapTelegramErrorToMessage(err);
      } catch {
        replyText = '⚠️ Si è verificato un problema temporaneo. Riprova tra poco.';
      }

      try {
        await safeReply(
          { reply: (replyTextValue: string) => bot.sendMessage(chatId, replyTextValue) },
          replyText,
        );
      } catch (sendErr) {
        deps.log?.error(
          { error: errorLabel(sendErr), requestId },
          'Failed to send Telegram error reply',
        );
      }
    }
  });
}

export function startTelegramBot(token: string, deps: BotDeps): TelegramClient {
  if (pollingActive) {
    if (botInstance) {
      return botInstance;
    }
  }

  if (botInstance) {
    return botInstance;
  }

  const bot = new TelegramClient(token);

  bot.on('polling_error', (err) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram polling error');
  });

  bot.on('webhook_error', (err) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram webhook error');
  });

  bot.on('error', (err) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram transport error');
  });

  botInstance = bot;
  deps.log?.info({ transport: 'telegram', mode: 'polling' }, 'Telegram bot started');
  attachMessageHandler(bot, deps);

  pollingActive = true;
  void bot.startPolling().catch((err: unknown) => {
    deps.log?.error({ error: errorLabel(err) }, 'Telegram polling start failure');
    pollingActive = false;
  });

  return bot;
}

export class TelegramBotService {
  constructor(private readonly deps: BotDeps) {}

  start(token: string) {
    startTelegramBot(token, this.deps);
  }
}
