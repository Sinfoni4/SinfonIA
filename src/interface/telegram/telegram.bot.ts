import TelegramBot from 'node-telegram-bot-api';

import { enrichWithAI } from '../../ai/module.enricher.js';
import { aiSuggestModule } from '../../ai/module.router.ai.js';
import { getTenantIdByInvite, bindUserToTenant } from '../../core/tenant/tenant.invite.store.js';
import { getTenantByUserAsync } from '../../core/tenant/tenant.store.js';
import { uuidFromSeed } from '../../core/tenant/tenant.uuid.js';
import { routeModulesForTenant } from '../../modules/module.router.js';
import { handleFlow } from '../flows/flow.orchestrator.js';

import { handleDevState } from './commands/devstate.command.js';
import { clearPending, getPending } from './telegram.conversation.js';
import { getConversationDebugState } from './telegram.conversation.js';
import { mapTelegramErrorToMessage } from './telegram.errors.js';
import {
  hasSeenUser,
  markUserSeen,
  resetTelegramMemory,
  getTelegramMemoryState,
} from './telegram.memory.js';
import { getUserRole, setUserRole, type UserRole } from './telegram.roles.js';
import { getRoleDebugState } from './telegram.roles.js';
import { runtimeAwareExecute } from './telegram.runtimeAware.js';
import { safeReply } from './telegram.transport.js';

import type { DomainContext } from '../../modules/domain.module.js';

const MODULE_TAKEOVER_ENABLED = true;

type BotDeps = {
  handleMessage: (input: string, userId: string) => Promise<string>;
  log?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

let botInstance: TelegramBot | null = null;
let pollingActive = false;

async function shutdownTelegram() {
  try {
    if (botInstance && pollingActive) {
      console.log('🛑 Stopping Telegram polling...');
      await botInstance.stopPolling();
      pollingActive = false;
      console.log('✅ Telegram polling stopped');
    }
  } catch (err) {
    console.error('Shutdown polling error:', err);
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

  // Handle Telegram commands
  if (t.startsWith('/')) return true;

  return ['ciao', 'hello', 'hi', 'help', 'start'].includes(t);
}

function onboardingMessage(role: UserRole): string {
  if (role === 'OPERATORE') {
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

function attachMessageHandler(bot: TelegramBot, deps: BotDeps): void {
  bot.on('message', async (msg) => {
    console.log('📩 TELEGRAM UPDATE RECEIVED');
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`📥 REQUEST START — id=${requestId}`);
    const text = msg.text;
    const chatId = msg.chat.id;
    if (!text) return;
    const userId = String(chatId);
    let responseSent = false;

    try {
      const trimmed = text.trim();

      let aiSuggestion: string | null = null;
      try {
        aiSuggestion = aiSuggestModule(trimmed);

        if (aiSuggestion) {
          console.log(`🧠 AI ROUTER — suggested=${aiSuggestion}`);
        } else {
          console.log(`🧠 AI ROUTER — no suggestion`);
        }
      } catch (err) {
        console.error('❌ AI ROUTER ERROR', err);
      }

      const lower = trimmed.toLowerCase();
      if (trimmed.startsWith('/start')) {
        const parts = trimmed.split(' ');
        const inviteCode = parts[1];

        if (inviteCode) {
          const tenantId = getTenantIdByInvite(inviteCode);

          if (!tenantId) {
            console.log(`❌ INVALID INVITE — code=${inviteCode}`);
            await bot.sendMessage(chatId, 'Codice invito non valido');
            return;
          }

          bindUserToTenant(userId, tenantId);

          console.log(`✅ USER JOINED TENANT — user=${userId} tenant=${tenantId}`);

          await bot.sendMessage(chatId, '🎵 Benvenuto! Sei stato collegato alla tua cooperativa.');

          return;
        }
      }
      console.log(`🧾 REQUEST DATA — id=${requestId} input="${trimmed}"`);
      console.log(`🏢 TENANT — id=${requestId} user=${userId}`);

      const routing = routeModulesForTenant(trimmed, userId);
      console.log(`🏢 TENANT ROUTING — user=${userId} module=${routing[0]?.module ?? 'none'}`);
      const tenant = await getTenantByUserAsync(userId);
      if (tenant._isFallback) {
        console.warn(`⚠️ TENANT FALLBACK ACTIVE — user=${userId}`);
      }
      if (aiSuggestion) {
        console.log(`🔍 ROUTING COMPARISON — ai=${aiSuggestion} tenant=${tenant.module}`);
      }
      if (routing.length === 0) {
        console.log(`🧭 ROUTING — id=${requestId} no match`);
      } else {
        console.log(
          `🧭 ROUTING — id=${requestId} matched=${routing.map((r) => r.module).join(',')}`,
        );
      }
      let moduleHandled = false;

      if (routing.length === 1) {
        const match = routing[0];

        if (match.module === 'music') {
          console.log('🚀 EXECUTION BRIDGE — executing module:', match.module);
          console.log(`🚀 MODULE START — id=${requestId} module=${match.module}`);
          let result: unknown;
          let domainContext: DomainContext | undefined;
          try {
            const tenant = await getTenantByUserAsync(userId);
            // Stable DB UUID for this Telegram user (same mapping as TelegramAdapter.execUserId).
            const execContext = {
              tenantId: tenant.id,
              userId: uuidFromSeed(userId),
            };

            try {
              domainContext = await match.instance.getContext(execContext);
              console.log(`🧠 CONTEXT LOADED — id=${requestId} module=${match.module}`);
            } catch (err) {
              console.error(`❌ CONTEXT FAILED — id=${requestId} module=${match.module}`, err);
            }

            result = await match.instance.execute(match.command, execContext, domainContext);
          } catch (err) {
            console.error(`❌ MODULE EXECUTION CRASH — ${match.module}`, err);
          }
          console.log(`✅ MODULE END — id=${requestId} module=${match.module}`);

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

              console.log(`🧠 AI ENRICHMENT APPLIED — id=${requestId}`);
            } catch (err) {
              console.error(`❌ AI ENRICHMENT ERROR — id=${requestId}`, err);
            }

            console.log(`📤 MODULE RESPONSE: ${finalMessage}`);

            await bot.sendMessage(chatId, finalMessage);
            console.log('✅ MODULE EXECUTION SUCCESS');
            responseSent = true;
            console.log(`📤 RESPONSE — id=${requestId} source=module`);
            moduleHandled = true;
          } else {
            console.warn(`⚠️ MODULE INVALID RESPONSE — ${match.module}`);
          }
        }
      }

      if (responseSent && !MODULE_TAKEOVER_ENABLED) {
        console.warn(`⚠️ RESPONSE WITHOUT TAKEOVER — id=${requestId}`);
      }

      if (moduleHandled && MODULE_TAKEOVER_ENABLED) {
        console.log(`🧩 TAKEOVER — id=${requestId} module=${routing[0]?.module ?? 'unknown'}`);
        console.log('🧩 MODULE TAKEOVER — skipping legacy flow');
        return;
      }

      if (!moduleHandled) {
        console.log('↩️ FALLBACK — using legacy flow');
      }

      if (lower === '/devstate') {
        if (process.env.NODE_ENV !== 'development') {
          return;
        }

        await runtimeAwareExecute(
          { reply: async (text: string) => bot.sendMessage(chatId, text) },
          async () => {
            await handleDevState({
              reply: async (runtimeReport) => {
                const memory = getTelegramMemoryState();
                const conversations = getConversationDebugState();
                const roles = getRoleDebugState();
                const report = `${runtimeReport}

Memory:
- seen users: ${memory.seenUsersCount}
- memory entries: ${memory.memoryEntries}

Conversation:
- active conversations: ${conversations.activeConversations}

Roles:
- tracked roles: ${roles.trackedRoles}`;
                await bot.sendMessage(chatId, report);
              },
            });
            console.log('🧪 DEV STATE requested by', msg.from?.username);
          },
        );
        return;
      }

      if (lower === '/devreset') {
        if (process.env.NODE_ENV !== 'development') {
          return;
        }

        await runtimeAwareExecute(
          { reply: async (text: string) => bot.sendMessage(chatId, text) },
          async () => {
            resetTelegramMemory();
            console.log('🧪 DEV RESET executed by', msg.from?.username);
            await bot.sendMessage(chatId, '🧹 Dev state reset complete.');
          },
        );
        return;
      }

      const userPending = getPending(userId);
      if (userPending?.type === 'AMBIGUITY_SELECTION') {
        if (lower.includes('10')) {
          clearPending(userId);
          await bot.sendMessage(chatId, '✅ Perfetto, procedo con la pratica del 10 marzo.');
          return;
        }

        if (lower.includes('12')) {
          clearPending(userId);
          await bot.sendMessage(chatId, '✅ Perfetto, procedo con la pratica del 12 marzo.');
          return;
        }
      }

      if (userPending?.type === 'REQUEST_OPERATOR') {
        if (lower.includes('sì') || lower.includes('si') || lower.includes('ok')) {
          clearPending(userId);
          await bot.sendMessage(
            chatId,
            '📩 Ho segnalato la richiesta a un operatore.\nTi aggiornerò appena viene gestita.',
          );
          return;
        }

        if (lower.includes('no')) {
          clearPending(userId);
          await bot.sendMessage(chatId, '👍 Va bene, nessuna azione eseguita.');
          return;
        }
      }

      // Role command must run before onboarding/greeting interception.
      if (lower.startsWith('/role')) {
        const nextRole: UserRole = lower.includes('operatore') ? 'OPERATORE' : 'ASSOCIATO';
        setUserRole(userId, nextRole);
        if (nextRole === 'OPERATORE') {
          await bot.sendMessage(chatId, '🔧 Modalità operatore attivata');
        } else {
          await bot.sendMessage(chatId, '👤 Modalità associato attivata');
        }
        return;
      }

      const role = getUserRole(userId);

      if (lower.startsWith('/start')) {
        await runtimeAwareExecute(
          { reply: async (text: string) => bot.sendMessage(chatId, text) },
          async () => {
            if (!hasSeenUser(userId)) {
              markUserSeen(userId);
              await bot.sendMessage(chatId, onboardingMessage(role));
            } else {
              await bot.sendMessage(chatId, '👋 Bentornato! Come posso aiutarti?');
            }
          },
        );
        return;
      }

      if (isGreeting(text)) {
        if (!hasSeenUser(userId)) {
          markUserSeen(userId);
          await bot.sendMessage(chatId, onboardingMessage(role));
        } else {
          await bot.sendMessage(chatId, '👋 Bentornato! Come posso aiutarti?');
        }
        return;
      }

      // Defensive layer: never let any Telegram command reach the AI pipeline.
      if (trimmed.startsWith('/')) {
        await bot.sendMessage(chatId, onboardingMessage(role));
        return;
      }

      const flowResponse = await handleFlow(text, userId);
      if (flowResponse) {
        if (responseSent) {
          console.warn(`⚠️ DOUBLE RESPONSE BLOCKED — id=${requestId}`);
        } else {
          console.log(`📤 RESPONSE — id=${requestId} source=legacy`);
        }
        await bot.sendMessage(chatId, flowResponse);
        return;
      }

      const response = await deps.handleMessage(text, userId);
      if (responseSent) {
        console.warn(`⚠️ DOUBLE RESPONSE BLOCKED — id=${requestId}`);
      } else {
        console.log(`📤 RESPONSE — id=${requestId} source=legacy`);
      }
      await bot.sendMessage(chatId, response);
    } catch (err) {
      console.error('Telegram handler error', err);
      deps.log?.error({ err }, 'Telegram handler error');

      let replyText: string;
      try {
        replyText = mapTelegramErrorToMessage(err);
      } catch {
        replyText = '⚠️ Si è verificato un problema temporaneo. Riprova tra poco.';
      }

      try {
        if (msg.chat?.id) {
          await safeReply(
            { reply: (text: string) => bot.sendMessage(msg.chat.id, text) },
            replyText,
          );
        }
      } catch (sendErr) {
        console.error('Telegram fallback send failed:', sendErr);
        deps.log?.error({ sendErr }, 'Failed to send error reply to user');
      }
    } finally {
      console.log(`📥 REQUEST END — id=${requestId}`);
    }
  });

  console.log('TELEGRAM HANDLERS REGISTERED:');
  console.log({ start: true, devreset: true, devstate: true });
  console.log('✅ Telegram handlers registered');
}

export function startTelegramBot(token: string, deps: BotDeps): TelegramBot {
  if (pollingActive) {
    console.warn('⚠️ Polling already active — skipping restart');
    if (botInstance) {
      return botInstance;
    }
  }

  if (botInstance) {
    console.log('⚠️ Telegram bot already running — skipping re-init');
    return botInstance;
  }

  console.log('TELEGRAM STEP 1 — bot instance creation');
  const bot = new TelegramBot(token, { polling: false });
  console.log('TELEGRAM STEP 3 — polling start');
  console.log('🤖 TelegramBot instance created');
  console.log('ENV:', process.env.NODE_ENV);
  console.log('📡 Polling should be active');

  bot.on('polling_error', (err) => {
    console.warn('⚠️ Polling error:', err.message);
  });

  bot.on('webhook_error', (err) => {
    console.error('❌ Webhook error:', err.message);
  });

  bot.on('error', (err) => {
    console.error('💥 Telegram transport error:', err);
  });

  // Temporary global tap for diagnostics.
  bot.on('message', (msg) => {
    console.log('📩 MESSAGE RECEIVED:', msg.text);
  });

  botInstance = bot;
  deps.log?.info({ transport: 'telegram', mode: 'polling' }, 'Telegram bot started');
  console.log('TELEGRAM STEP 2 — registering handlers');
  attachMessageHandler(bot, deps);

  pollingActive = true;
  try {
    void bot.startPolling().catch((e) => {
      console.error('❌ Polling start failure:', e);
    });
  } catch (e) {
    console.error('❌ Polling start threw:', e);
  }

  console.log('🤖 Telegram bot polling enabled');
  console.log('TELEGRAM STEP 4 — polling active');
  console.log('💬 Bot ready to receive messages');

  return bot;
}

export class TelegramBotService {
  constructor(private readonly deps: BotDeps) {}

  start(token: string) {
    startTelegramBot(token, this.deps);
  }
}
