/**
 * The assistant of the Telegram Mini App: the same conversation as the bot, with the person given
 * by the app's session (never by a chat id), in the organization chosen there.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { createAppChat, type AppChatReply } from '../src/interface/conversation/app-chat.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ConversationIdentity } from '../src/interface/conversation/conversation.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('the assistant of the Mini App', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org = { a: '', b: '' };
  const people: Record<string, string> = {};
  const handleMessage = vi.fn((input: string, identity: ConversationIdentity) =>
    Promise.resolve(`AI: ${input} (${identity.userId === people.farmer ? 'farmer' : 'other'})`),
  );

  const say = async (who: string, o: keyof typeof org, text: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/miniapp/chat',
      headers: authHeaders(org[o], people[who], 'MEMBER'),
      payload: { text },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: { replies: AppChatReply[] } }>().data.replies;
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    org.a = (await tenants.createTenant({ name: `Azienda A ${run}`, module: 'agri' })).id;
    org.b = (await tenants.createTenant({ name: `Azienda B ${run}`, module: 'agri' })).id;
    const users = new UserRepository(prisma);
    people.farmer = (
      await users.createUser(org.a, { email: `farmer-${run}@app.local`, role: 'MEMBER' })
    ).id;
    people.neighbour = (
      await users.createUser(org.b, { email: `neighbour-${run}@app.local`, role: 'MEMBER' })
    ).id;
    const practices = new PracticeApplicationService(prisma);
    await practices.createPractice({
      tenantId: org.a,
      userId: people.farmer,
      name: `Domanda PAC ${run}`,
    });
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3019',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-miniapp-chat',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      practiceService: practices,
      interpreterService: new InterpreterService(llm),
      executorService: new ExecutorService({ practiceService: practices }),
      contextService: new ContextService(practices),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
      appChat: createAppChat(prisma, { practiceService: practices, handleMessage }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('answers the commands of the chat for the person of the session', async () => {
    const replies = await say('farmer', 'a', 'lista pratiche');
    expect(replies.map((r) => r.text).join('\n')).toContain(`Domanda PAC ${run}`);
    // Another organization's member does not see that practice.
    const other = await say('neighbour', 'b', 'lista pratiche');
    expect(other.map((r) => r.text).join('\n')).not.toContain(`Domanda PAC ${run}`);
  });

  it('sends free text to the assistant with the identity of the session', async () => {
    const replies = await say('farmer', 'a', 'come faccio a chiedere il contributo?');
    expect(replies[0].text).toBe('AI: come faccio a chiedere il contributo? (farmer)');
    expect(handleMessage).toHaveBeenLastCalledWith(
      'come faccio a chiedere il contributo?',
      expect.objectContaining({ tenantId: org.a, userId: people.farmer }),
    );
  });

  it('does not offer the linking of a chat account: the session already says who it is', async () => {
    const replies = await say('farmer', 'a', '/accedi');
    expect(replies.map((r) => r.text).join('\n')).not.toMatch(/email/i);
  });

  it('refuses an empty message and works only with a session', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/miniapp/chat',
      headers: authHeaders(org.a, people.farmer, 'MEMBER'),
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    const anonymous = await app.inject({
      method: 'POST',
      url: '/miniapp/chat',
      payload: { text: 'lista pratiche' },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
