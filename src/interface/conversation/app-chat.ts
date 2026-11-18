import { getTenantById } from '../../core/tenant/tenant.store.js';

import {
  ConversationService,
  type ConversationDeps,
  type ReplyButton,
  type ReplyOptions,
} from './conversation.service.js';

import type { Principal } from '../../core/authz/authorization.service.js';
import type { PrismaClient } from '@prisma/client';

/** One answer of the assistant in the app, with the buttons that answer it. */
export type AppChatReply = { text: string; buttons: ReplyButton[] };

/** The assistant of the Telegram Mini App: one message in, the answers out. */
export type AppChat = {
  ask(principal: Principal, text: string): Promise<AppChatReply[]>;
};

/**
 * The assistant inside the Telegram Mini App: the same conversation as the bot (commands, AI,
 * menus, confirmations), with the person already identified by the app's session, in the
 * organization chosen there. Text only: files are sent in the chat.
 */
export function createAppChat(prisma: PrismaClient, deps: ConversationDeps): AppChat {
  // The people asking right now, by the sender id given to the conversation.
  const asking = new Map<string, Principal>();
  const conversation = new ConversationService(deps, {
    name: 'app',
    identity: {
      async resolve(senderId) {
        const principal = asking.get(senderId);
        if (!principal) throw new Error('No app session for this message');
        return {
          tenant: await getTenantById(prisma, principal.tenantId),
          userId: principal.userId,
          role: principal.role,
          customPermissions: principal.customPermissions,
        };
      },
      tenantFor: (tenantId) => getTenantById(prisma, tenantId),
    },
  });
  let sequence = 0;
  return {
    async ask(principal, text) {
      const senderId = `app:${principal.userId}:${++sequence}`;
      const replies: AppChatReply[] = [];
      asking.set(senderId, principal);
      try {
        await conversation.handle({ senderId, text }, (reply: string, options?: ReplyOptions) => {
          replies.push({ text: reply, buttons: options?.buttons ?? [] });
          return Promise.resolve();
        });
      } finally {
        asking.delete(senderId);
      }
      return replies;
    },
  };
}
