/**
 * Dispatchers of their own (AGX-08 follow-up): the slow document reads go to an OCR dispatcher,
 * the notices to the main one. Each claims only its event types, so neither dead-letters the
 * other's messages for want of a handler. Event types unique to this test: the queue is shared
 * with the other test files.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OutboxDispatcher } from '../src/core/outbox/outbox.dispatcher.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { OutboxRepository } from '../src/data/repositories/outbox.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';

import type { OutboxEventHandler } from '../src/core/outbox/outbox.delivery.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('outbox claims by event type', () => {
  const run = randomUUID().slice(0, 8).toUpperCase();
  const types = { notice: `TEST_NOTICE_${run}`, read: `TEST_READ_${run}` };
  let prisma: PrismaClient;
  let tenantId = '';

  const enqueue = async (eventType: string) =>
    (
      await new OutboxRepository(prisma).createMessage({
        tenantId,
        eventType,
        payload: { run },
      })
    ).id;
  const statusOf = async (id: string) =>
    (await prisma.outboxMessage.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (await new TenantRepository(prisma).createTenant({ name: `Outbox ${run}` })).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('claims only the types asked for, and never the excluded ones', async () => {
    const notice = await enqueue(types.notice);
    const read = await enqueue(types.read);
    const claimed = await new OutboxRepository(prisma).claimDue({
      now: new Date(),
      leaseMs: 60_000,
      limit: 50,
      only: [types.notice, types.read],
      except: [types.read],
    });
    expect(claimed.map((m) => m.id)).toEqual([notice]);
    expect(await statusOf(read)).toBe('PENDING');
  });

  it('lets a dispatcher with `only` handle just its own messages', async () => {
    const read = await enqueue(types.read);
    const notice = await enqueue(types.notice);
    const seen: string[] = [];
    const handler: OutboxEventHandler = {
      eventType: types.read,
      resolveDeliveries: (message) => {
        seen.push(message.id);
        return Promise.resolve([{ target: 'test', send: () => Promise.resolve() }]);
      },
    };
    const ocr = new OutboxDispatcher(prisma, { handlers: [handler], only: true, batchSize: 50 });
    for (let i = 0; i < 5 && (await statusOf(read)) !== 'PROCESSED'; i++) {
      await ocr.dispatchOnce();
    }
    expect(seen).toContain(read);
    expect(await statusOf(read)).toBe('PROCESSED');
    // The other type is left for its own dispatcher: not dead-lettered here.
    expect(await statusOf(notice)).toBe('PENDING');
  });
});
