/**
 * Phase 0 of the integrated schedule (security and integrity):
 * - S02: the AI proposes a change of state, the chat asks «sì» before doing it;
 * - S05: a deletion from the chat is done only after «sì»;
 * - S04: a permission revoked while a notice waits in the queue stops its delivery;
 * - S06: no access to another organization through chat commands, confirmations, exports, files;
 * - S10: actions sent twice at the same time take effect once.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requestAssistance } from '../src/core/assistance/assistance.service.js';
import { revokeMembership } from '../src/core/identity/revocation.service.js';
import { PracticeStatusHandler } from '../src/core/outbox/practice-status.handler.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';

import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { ClaimedOutboxMessage } from '../src/data/repositories/outbox.repository.js';
import type { ReplyOptions } from '../src/interface/conversation/conversation.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const PRACTICE_ID = '550e8400-e29b-41d4-a716-446655440000';

type Fake = ReturnType<typeof vi.fn>;

function chat(deps: { handleMessage?: Fake; executeCommand?: Fake }) {
  const executeCommand = deps.executeCommand ?? vi.fn();
  const handleMessage = deps.handleMessage ?? vi.fn().mockResolvedValue('ok');
  const service = new ConversationService(
    // Fakes of the practice service and of the AI: the types of the real ones are not needed here.
    { practiceService: { executeCommand } as never, handleMessage: handleMessage as never },
    {
      name: 'telegram',
      identity: {
        resolve: () =>
          Promise.resolve({
            tenant: { id: 't-1', name: 'Azienda' } as Tenant,
            userId: 'u-1',
            role: 'OPERATOR',
            customPermissions: null,
          }),
      },
    },
  );
  const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  const say = (text: string) =>
    service.handle({ senderId: '1', text }, (t, options) => {
      replies.push({ text: t, options });
      return Promise.resolve();
    });
  return { say, replies, executeCommand, handleMessage };
}

describe('S02: a change of state proposed by the AI', () => {
  const proposal = {
    text: '❓ Vuoi completare la pratica «Vigna»? Rispondi «sì» per confermare.',
    confirmTransition: { practiceId: PRACTICE_ID, nextState: 'COMPLETED' },
  };

  it('is done only after «sì», through the normal command with every check', async () => {
    const c = chat({
      handleMessage: vi.fn().mockResolvedValue(proposal),
      executeCommand: vi.fn().mockResolvedValue({
        type: 'transitioned',
        practice: { name: 'Vigna', status: 'COMPLETED' },
      }),
    });
    await c.say('completa la pratica della vigna');
    expect(c.replies.at(-1)?.options?.buttons?.map((b) => b.label)).toEqual(['Sì', 'No']);
    expect(c.executeCommand).not.toHaveBeenCalled();
    await c.say('sì');
    expect(c.executeCommand).toHaveBeenCalledWith(
      { type: 'CONFIRM_TRANSITION', payload: { practiceId: PRACTICE_ID, nextState: 'COMPLETED' } },
      { tenantId: 't-1', userId: 'u-1', role: 'OPERATOR', customPermissions: null },
      { channel: 'telegram' },
    );
  });

  it('is dropped by any other answer', async () => {
    const c = chat({ handleMessage: vi.fn().mockResolvedValue(proposal) });
    await c.say('completa la pratica della vigna');
    await c.say('no');
    expect(c.replies.at(-1)?.text).toBe('Ok, operazione annullata.');
    expect(c.executeCommand).not.toHaveBeenCalled();
  });
});

describe('S05: a deletion from the chat', () => {
  it('asks first, and deletes only after «sì»', async () => {
    const practice = { id: PRACTICE_ID, name: 'Vigna', status: 'CREATED' };
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ type: 'confirm_delete', practice })
      .mockResolvedValueOnce({ type: 'deleted', practice });
    const c = chat({ executeCommand });
    await c.say('elimina pratica Vigna');
    expect(c.replies.at(-1)?.text).toContain('Vuoi davvero eliminare la pratica Vigna?');
    expect(c.replies.at(-1)?.options?.buttons?.map((b) => b.label)).toEqual(['Sì', 'No']);
    await c.say('sì');
    expect(executeCommand).toHaveBeenLastCalledWith(
      { type: 'CONFIRM_DELETE', payload: { practiceId: PRACTICE_ID } },
      expect.anything(),
      expect.anything(),
    );
    expect(c.replies.at(-1)?.text).toContain('Pratica eliminata: Vigna');
  });

  it('deletes nothing without «sì»', async () => {
    const executeCommand = vi.fn().mockResolvedValueOnce({
      type: 'confirm_delete',
      practice: { id: PRACTICE_ID, name: 'Vigna', status: 'CREATED' },
    });
    const c = chat({ executeCommand });
    await c.say('elimina pratica Vigna');
    await c.say('aspetta');
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });
});

describe('S06: files stay in the folder of their organization', () => {
  it('refuses a path that leaves the folder of the organization', async () => {
    const storage = new LocalStorageService(path.resolve('.runtime', 'storage-phase0'));
    await expect(storage.read('org-a', '../org-b/secret.pdf')).rejects.toThrow('Access denied');
    await expect(storage.read('org-a', 'org-a-other/secret.pdf')).rejects.toThrow('Access denied');
  });
});

describe.runIf(Boolean(DATABASE_URL))('phase 0 with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  const digits = run.replace(/\D/g, '1').slice(0, 6);
  let prisma: PrismaClient;
  let practices: PracticeApplicationService;
  const org = { a: '', b: '' };
  const people: Record<string, string> = {};
  const chats = { member: `94${digits}1` };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    practices = new PracticeApplicationService(prisma);
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.a = (await tenants.createTenant({ name: `Fase0 A ${run}` })).id;
    org.b = (await tenants.createTenant({ name: `Fase0 B ${run}` })).id;
    people.adminA = (
      await users.createUser(org.a, { email: `admin-a-${run}@phase0.local`, role: 'ADMIN' })
    ).id;
    people.memberA = (
      await users.createUser(org.a, {
        email: `member-a-${run}@phase0.local`,
        role: 'MEMBER',
        telegramId: chats.member,
      })
    ).id;
    people.adminB = (
      await users.createUser(org.b, { email: `admin-b-${run}@phase0.local`, role: 'ADMIN' })
    ).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe('S06: no access to another organization', () => {
    it('through chat commands, confirmations and exports', async () => {
      const secret = await practices.createPractice({
        tenantId: org.b,
        userId: people.adminB,
        name: `Segreto B ${run}`,
      });
      const actorA = {
        tenantId: org.a,
        userId: people.adminA,
        role: 'ADMIN' as const,
        customPermissions: null,
      };
      const status = await practices.executeCommand(
        { type: 'GET_ORG_PRACTICE_STATUS', payload: { name: `Segreto B ${run}` } },
        actorA,
      );
      expect(status.type).toBe('not_found');
      // An id of another organization, as a forged confirmation would carry it.
      await expect(
        practices.executeCommand(
          {
            type: 'CONFIRM_TRANSITION',
            payload: { practiceId: secret.id, nextState: 'VALIDATED' },
          },
          actorA,
        ),
      ).rejects.toThrow();
      await expect(
        practices.executeCommand(
          { type: 'CONFIRM_DELETE', payload: { practiceId: secret.id } },
          actorA,
        ),
      ).rejects.toThrow();
      const exported = await practices.exportPractices({
        tenantId: org.a,
        filter: { type: 'all' },
      });
      expect(exported.csv).not.toContain(`Segreto B ${run}`);
      expect((await prisma.practice.findUniqueOrThrow({ where: { id: secret.id } })).status).toBe(
        'CREATED',
      );
    });
  });

  describe('S04: revocation while a notice waits in the queue', () => {
    it('delivers nothing to a member revoked after the notice was queued', async () => {
      const practice = await practices.createPractice({
        tenantId: org.a,
        userId: people.memberA,
        name: `Revoca ${run}`,
      });
      await practices.transitionPractice({
        tenantId: org.a,
        userId: people.adminA,
        practiceId: practice.id,
        nextState: 'VALIDATED',
      });
      const message = await prisma.outboxMessage.findFirstOrThrow({
        where: {
          tenantId: org.a,
          eventType: 'PRACTICE_STATUS_CHANGED',
          payload: { path: ['practiceId'], equals: practice.id },
        },
      });
      const sent: string[] = [];
      const telegram: ChatNotifier = {
        sendDocument: () => Promise.resolve(),
        sendMessage: (chatId) => {
          sent.push(chatId);
          return Promise.resolve();
        },
      };
      const handler = new PracticeStatusHandler(prisma, { telegram });
      const before = await handler.resolveDeliveries(message as unknown as ClaimedOutboxMessage);
      expect(before.map((d) => d.target)).toEqual([`telegram:${chats.member}`]);

      await revokeMembership(prisma, org.a, people.memberA, { userId: people.adminA });
      const after = await handler.resolveDeliveries(message as unknown as ClaimedOutboxMessage);
      for (const d of after) await d.send();
      expect(sent).toEqual([]);
    });
  });

  describe('S10: the same action sent twice at once', () => {
    it('moves a practice once', async () => {
      const practice = await practices.createPractice({
        tenantId: org.a,
        userId: people.adminA,
        name: `Doppio ${run}`,
      });
      const move = () =>
        practices.transitionPractice({
          tenantId: org.a,
          userId: people.adminA,
          practiceId: practice.id,
          nextState: 'VALIDATED',
        });
      const results = await Promise.allSettled([move(), move()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.auditLog.count({
          where: {
            tenantId: org.a,
            eventType: 'PRACTICE_STATE_CHANGED',
            payload: { path: ['practiceId'], equals: practice.id },
          },
        }),
      ).toBe(1);
    });

    it('records one assistance request', async () => {
      const ask = () =>
        requestAssistance(prisma, {
          tenantId: org.a,
          userId: people.adminA,
          topic: 'OTHER',
          channel: 'TELEGRAM',
        });
      const results = await Promise.all([ask(), ask(), ask()]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(
        await prisma.assistanceRequest.count({
          where: { tenantId: org.a, userId: people.adminA },
        }),
      ).toBe(1);
    });

    it('deletes a practice once when the confirmation arrives twice', async () => {
      const practice = await practices.createPractice({
        tenantId: org.a,
        userId: people.adminA,
        name: `Elimina due volte ${run}`,
      });
      const actor = {
        tenantId: org.a,
        userId: people.adminA,
        role: 'ADMIN' as const,
        customPermissions: null,
      };
      const confirm = () =>
        practices.executeCommand(
          { type: 'CONFIRM_DELETE', payload: { practiceId: practice.id } },
          actor,
        );
      const results = await Promise.allSettled([confirm(), confirm()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.practice.count({ where: { id: practice.id } })).toBe(0);
    });
  });
});
