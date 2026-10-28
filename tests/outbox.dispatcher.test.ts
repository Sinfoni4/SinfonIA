import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DeliveryError } from '../src/core/outbox/outbox.delivery.js';
import {
  computeBackoffMs,
  NO_HANDLER,
  NO_RECIPIENTS,
  OutboxDispatcher,
} from '../src/core/outbox/outbox.dispatcher.js';
import {
  PRACTICE_EXPORT_GENERATED,
  PracticeExportHandler,
} from '../src/core/outbox/practice-export.handler.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { OutboxRepository } from '../src/data/repositories/outbox.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { TelegramApiError } from '../src/interface/telegram/telegram.client.js';
import { createTelegramNotifier } from '../src/interface/telegram/telegram.notifier.js';
import {
  createWebhookNotifier,
  SIGNATURE_HEADER,
  signWebhookBody,
  TIMESTAMP_HEADER,
} from '../src/interface/webhook/webhook.notifier.js';

import type {
  OutboxDocument,
  TelegramNotifier,
  WebhookEvent,
  WebhookNotifier,
} from '../src/core/outbox/outbox.delivery.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

const SECRET = 'outbox-test-webhook-secret-0123456789';

describe('outbox backoff', () => {
  it('doubles the delay per attempt, with jitter, up to the cap', () => {
    const fixed = () => 0.5; // jitter factor 1.0
    const options = { baseMs: 1000, maxMs: 10_000, random: fixed };
    expect(computeBackoffMs(1, options)).toBe(1000);
    expect(computeBackoffMs(2, options)).toBe(2000);
    expect(computeBackoffMs(3, options)).toBe(4000);
    expect(computeBackoffMs(10, options)).toBe(10_000);
    expect(computeBackoffMs(1, { ...options, random: () => 0 })).toBe(800);
    expect(computeBackoffMs(1, { ...options, random: () => 1 })).toBe(1200);
  });

  it('honours a longer retry-after from the receiver, within the cap', () => {
    expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 60_000, retryAfterMs: 30_000 })).toBe(30_000);
    expect(
      computeBackoffMs(1, { baseMs: 1000, maxMs: 60_000, retryAfterMs: 999_999_999_000 }),
    ).toBe(60_000);
  });
});

describe('telegram notifier', () => {
  const doc: OutboxDocument = {
    filename: 'a.csv',
    content: Buffer.from('x'),
    mimeType: 'text/csv',
  };

  it.each([
    [403, true],
    [400, true],
    [500, false],
  ])('maps Bot API error %i to permanent=%s', async (code, permanent) => {
    const notifier = createTelegramNotifier({
      sendDocument: () => Promise.reject(new TelegramApiError('failed', code)),
      sendMessage: vi.fn(),
    });
    await expect(notifier.sendDocument('1', doc, 'c')).rejects.toMatchObject({ permanent });
  });

  it('waits for retry_after on flood control', async () => {
    const notifier = createTelegramNotifier({
      sendDocument: () => Promise.reject(new TelegramApiError('too many', 429, 7)),
      sendMessage: vi.fn(),
    });
    await expect(notifier.sendDocument('1', doc, 'c')).rejects.toMatchObject({
      permanent: false,
      retryAfterMs: 7000,
    });
  });
});

describe('webhook notifier', () => {
  const event: WebhookEvent = {
    id: 'msg-1',
    eventType: PRACTICE_EXPORT_GENERATED,
    tenantId: 't-1',
    createdAt: '2026-10-28T10:00:00.000Z',
    data: { practiceCount: 2 },
  };

  // Test hosts resolve to a public documentation address; no real DNS query is made.
  const lookup = () => Promise.resolve(['203.0.113.10']);

  it('signs the body with the timestamp and sends a stable delivery id', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const notifier = createWebhookNotifier({
      secret: SECRET,
      fetchImpl,
      lookup,
      now: () => new Date('2026-10-28T10:00:00Z'),
    });

    await notifier.post('https://erp.example.test/hook', event);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[TIMESTAMP_HEADER]).toBe(String(Date.parse('2026-10-28T10:00:00Z') / 1000));
    expect(headers[SIGNATURE_HEADER]).toBe(
      signWebhookBody(SECRET, headers[TIMESTAMP_HEADER], init.body as string),
    );
    expect(headers['x-sinfonia-delivery']).toBe('msg-1');
    expect(init.redirect).toBe('manual');
  });

  it('refuses plain http unless explicitly allowed', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const strict = createWebhookNotifier({ secret: SECRET, fetchImpl, lookup });
    await expect(strict.post('http://erp.example.test/hook', event)).rejects.toMatchObject({
      permanent: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const dev = createWebhookNotifier({
      secret: SECRET,
      fetchImpl,
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
    });
    await dev.post('http://localhost:4000/hook', event);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, true],
    [404, true],
    [408, false],
    [429, false],
    [503, false],
  ])('treats HTTP %i as permanent=%s', async (status, permanent) => {
    const notifier = createWebhookNotifier({
      secret: SECRET,
      fetchImpl: () => Promise.resolve(new Response(null, { status })),
      lookup,
    });
    await expect(notifier.post('https://erp.example.test/hook', event)).rejects.toMatchObject({
      permanent,
    });
  });

  it('retries when the endpoint is unreachable', async () => {
    const notifier = createWebhookNotifier({
      secret: SECRET,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      lookup,
    });
    await expect(notifier.post('https://erp.example.test/hook', event)).rejects.toMatchObject({
      permanent: false,
    });
  });

  it('treats a redirect as permanent and does not follow it', async () => {
    const notifier = createWebhookNotifier({
      secret: SECRET,
      lookup,
      fetchImpl: () =>
        Promise.resolve(
          new Response(null, { status: 301, headers: { location: 'https://new.example.test/' } }),
        ),
    });
    await expect(notifier.post('https://erp.example.test/hook', event)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('https://new.example.test/') as unknown,
    });
  });

  it.each([
    ['https://127.0.0.1/hook', undefined],
    ['https://[::1]/hook', undefined],
    ['https://metadata.example.test/hook', '169.254.169.254'],
    ['https://intranet.example.test/hook', '10.1.2.3'],
    ['https://mapped.example.test/hook', '::ffff:192.168.1.5'],
  ])('refuses internal address %s', async (url, resolved) => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const notifier = createWebhookNotifier({
      secret: SECRET,
      fetchImpl,
      lookup: () => Promise.resolve(resolved ? [resolved] : []),
    });
    await expect(notifier.post(url, event)).rejects.toMatchObject({ permanent: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

type FakeChannels = {
  telegram: TelegramNotifier & {
    sent: string[];
    texts: Array<{ chatId: string; text: string }>;
    failWith: Map<string, Error>;
  };
  webhook: WebhookNotifier & { sent: WebhookEvent[]; failWith: Error | null };
};

// The outbox is shared by every run against the test database, and messages left for retry by an
// earlier run are claimed too. Chat ids carry a per-run prefix and tenants are tracked, so the
// fake channels only record (and fail) this run's deliveries.
const RUN = String(Date.now()).slice(-7);
const runTenants = new Set<string>();
const chat = (id: string) => `${RUN}${id}`;

function fakeChannels(): FakeChannels {
  const telegram = {
    sent: [] as string[],
    texts: [] as Array<{ chatId: string; text: string }>,
    failWith: new Map<string, Error>(),
    sendDocument(chatId: string) {
      if (!chatId.startsWith(RUN)) return Promise.resolve();
      const id = chatId.slice(RUN.length);
      const err = telegram.failWith.get(id);
      if (err) return Promise.reject(err);
      telegram.sent.push(id);
      return Promise.resolve();
    },
    sendMessage(chatId: string, text: string) {
      if (!chatId.startsWith(RUN)) return Promise.resolve();
      const id = chatId.slice(RUN.length);
      const err = telegram.failWith.get(id);
      if (err) return Promise.reject(err);
      telegram.sent.push(id);
      telegram.texts.push({ chatId: id, text });
      return Promise.resolve();
    },
  };
  const webhook = {
    sent: [] as WebhookEvent[],
    failWith: null as Error | null,
    post(_url: string, event: WebhookEvent) {
      if (!runTenants.has(event.tenantId)) return Promise.resolve();
      if (webhook.failWith) return Promise.reject(webhook.failWith);
      webhook.sent.push(event);
      return Promise.resolve();
    },
  };
  return { telegram, webhook };
}

describeWithDb('outbox dispatcher with PostgreSQL (Step 5)', () => {
  let prisma: PrismaClient;
  let clock: Date;
  const now = () => clock;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setupTenant(options: { admins?: string[]; webhookUrl?: string } = {}) {
    const tenant = await new TenantRepository(prisma).createTenant({
      name: `t-outbox-${randomUUID()}`,
    });
    if (options.webhookUrl) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { webhookUrl: options.webhookUrl },
      });
    }
    const users = new UserRepository(prisma);
    for (const telegramId of options.admins ?? []) {
      await users.createUser(tenant.id, {
        email: `admin-${chat(telegramId)}@outbox.local`,
        role: 'ADMIN',
        telegramId: chat(telegramId),
      });
    }
    // Members never receive exports.
    await users.createUser(tenant.id, {
      email: `member-${randomUUID()}@outbox.local`,
      role: 'MEMBER',
      telegramId: `m-${randomUUID().slice(0, 8)}`,
    });
    runTenants.add(tenant.id);
    return tenant.id;
  }

  async function enqueue(tenantId: string, eventType = PRACTICE_EXPORT_GENERATED) {
    const message = await new OutboxRepository(prisma).createMessage({
      tenantId,
      eventType,
      payload: { title: 'Export ottobre', csv: 'id;nome\n1;Prova', practiceCount: 1 },
    });
    // The message is due from the DB time of its insert: keep the test clock past it, even when
    // a loaded machine makes the setup slower than expected.
    if (clock.getTime() <= message.nextAttemptAt.getTime()) {
      clock = new Date(message.nextAttemptAt.getTime() + 1000);
    }
    return message;
  }

  function dispatcher(channels: Partial<FakeChannels>, options: { maxAttempts?: number } = {}) {
    return new OutboxDispatcher(prisma, {
      handlers: [new PracticeExportHandler(prisma, channels)],
      // Other test files write outbox messages too: claim generously, assert only on our tenants.
      batchSize: 500,
      baseBackoffMs: 1000,
      maxBackoffMs: 60_000,
      random: () => 0.5,
      now,
      ...options,
    });
  }

  async function reload(id: string) {
    return prisma.outboxMessage.findUniqueOrThrow({ where: { id } });
  }

  beforeAll(() => {
    // Ahead of the DB clock, so freshly created messages are already due.
    clock = new Date(Date.now() + 1000);
  });

  it('delivers an export to every Telegram admin and to the webhook, once', async () => {
    const tenantId = await setupTenant({
      admins: ['1001', '1002'],
      webhookUrl: 'https://erp.example.test/hook',
    });
    const message = await enqueue(tenantId);
    const channels = fakeChannels();

    await dispatcher(channels).dispatchOnce();

    const row = await reload(message.id);
    expect(row.status).toBe('PROCESSED');
    expect(row.attempts).toBe(1);
    expect(row.deliveredTargets.sort()).toEqual([
      `telegram:${chat('1001')}`,
      `telegram:${chat('1002')}`,
      'webhook',
    ]);
    expect(channels.telegram.sent.sort()).toEqual(['1001', '1002']);
    expect(channels.webhook.sent.map((e) => e.id)).toEqual([message.id]);

    await dispatcher(channels).dispatchOnce();
    expect(channels.telegram.sent).toHaveLength(2);
  });

  it('retries with backoff and never resends a target already delivered', async () => {
    const tenantId = await setupTenant({
      admins: ['2001'],
      webhookUrl: 'https://erp.example.test/hook',
    });
    const message = await enqueue(tenantId);
    const channels = fakeChannels();
    channels.webhook.failWith = new DeliveryError('Webhook ha risposto 503', { permanent: false });

    await dispatcher(channels).dispatchOnce();
    let row = await reload(message.id);
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('webhook: Webhook ha risposto 503');
    expect(row.nextAttemptAt.getTime()).toBe(clock.getTime() + 1000);
    expect(row.deliveredTargets).toEqual([`telegram:${chat('2001')}`]);

    // Not due yet.
    await dispatcher(channels).dispatchOnce();
    expect((await reload(message.id)).attempts).toBe(1);

    channels.webhook.failWith = null;
    advance(1000);
    await dispatcher(channels).dispatchOnce();
    row = await reload(message.id);
    expect(row.status).toBe('PROCESSED');
    expect(row.attempts).toBe(2);
    expect(row.error).toBeNull();
    expect(channels.telegram.sent).toEqual(['2001']);
    expect(channels.webhook.sent).toHaveLength(1);
  });

  it('moves a message to dead letter after the maximum attempts, and can requeue it', async () => {
    const tenantId = await setupTenant({ admins: ['3001'] });
    const message = await enqueue(tenantId);
    const channels = fakeChannels();
    channels.telegram.failWith.set('3001', new Error('socket hang up'));

    for (let i = 0; i < 3; i++) {
      await dispatcher(channels, { maxAttempts: 3 }).dispatchOnce();
      advance(60_000);
    }
    const row = await reload(message.id);
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.attempts).toBe(3);
    expect(row.error).toContain('Tentativi esauriti (3)');

    channels.telegram.failWith.clear();
    expect(await new OutboxRepository(prisma).requeueDeadLetter(message.id, clock)).toBe(true);
    await dispatcher(channels).dispatchOnce();
    expect((await reload(message.id)).status).toBe('PROCESSED');
    expect(channels.telegram.sent).toEqual(['3001']);
  });

  it('dead-letters permanent failures immediately', async () => {
    const tenantId = await setupTenant({ admins: ['4001'] });
    const message = await enqueue(tenantId);
    const channels = fakeChannels();
    channels.telegram.failWith.set(
      '4001',
      new DeliveryError('Forbidden: bot was blocked by the user', { permanent: true }),
    );

    await dispatcher(channels).dispatchOnce();
    const row = await reload(message.id);
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.attempts).toBe(1);
    expect(row.error).toContain('bot was blocked');
  });

  it('dead-letters a webhook when no signing secret is configured', async () => {
    const tenantId = await setupTenant({ webhookUrl: 'https://erp.example.test/hook' });
    const message = await enqueue(tenantId);

    await dispatcher({ telegram: fakeChannels().telegram }).dispatchOnce();
    const row = await reload(message.id);
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.error).toContain('OUTBOX_WEBHOOK_SECRET');
  });

  it('dead-letters messages without recipients or without a handler', async () => {
    const tenantId = await setupTenant();
    const noRecipients = await enqueue(tenantId);
    const unknown = await enqueue(tenantId, 'SOMETHING_ELSE');

    await dispatcher(fakeChannels()).dispatchOnce();
    expect((await reload(noRecipients.id)).error).toBe(NO_RECIPIENTS);
    expect((await reload(unknown.id)).error).toBe(`${NO_HANDLER}: SOMETHING_ELSE`);
    expect((await reload(unknown.id)).status).toBe('DEAD_LETTER');
  });

  it('delivers each message exactly once with two concurrent dispatchers', async () => {
    const prisma2 = createPrismaClient(DATABASE_URL!);
    await prisma2.$connect();
    try {
      const tenantId = await setupTenant({ admins: ['5001'] });
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push((await enqueue(tenantId)).id);

      const channels = fakeChannels();
      const second = new OutboxDispatcher(prisma2, {
        handlers: [new PracticeExportHandler(prisma2, channels)],
        batchSize: 3,
        now,
      });
      const first = new OutboxDispatcher(prisma, {
        handlers: [new PracticeExportHandler(prisma, channels)],
        batchSize: 3,
        now,
      });
      // Drain the queue with both workers racing on every round.
      for (let round = 0; round < 200; round++) {
        const [a, b] = await Promise.all([first.dispatchOnce(), second.dispatchOnce()]);
        const rows = await prisma.outboxMessage.findMany({ where: { id: { in: ids } } });
        if (rows.every((r) => r.status === 'PROCESSED') || a.claimed + b.claimed === 0) break;
      }

      const rows = await prisma.outboxMessage.findMany({ where: { id: { in: ids } } });
      expect(rows.every((r) => r.status === 'PROCESSED' && r.attempts === 1)).toBe(true);
      expect(channels.telegram.sent).toHaveLength(10);
    } finally {
      await prisma2.$disconnect();
    }
  });

  it('reclaims a message whose worker died after its lease expired', async () => {
    const tenantId = await setupTenant({ admins: ['6001'] });
    const message = await enqueue(tenantId);
    const repo = new OutboxRepository(prisma);

    // A worker claims the message and never reports back.
    const claimed = await repo.claimDue({ now: clock, leaseMs: 60_000, limit: 500 });
    expect(claimed.map((m) => m.id)).toContain(message.id);

    const channels = fakeChannels();
    await dispatcher(channels).dispatchOnce();
    expect((await reload(message.id)).status).toBe('PROCESSING');

    advance(60_001);
    await dispatcher(channels).dispatchOnce();
    const row = await reload(message.id);
    expect(row.status).toBe('PROCESSED');
    expect(row.attempts).toBe(2);

    // The dead worker's late update is fenced off by the claim token.
    const stale = claimed.find((m) => m.id === message.id)!;
    expect(await repo.scheduleRetry(stale, clock, 'late')).toBe(false);
    expect((await reload(message.id)).status).toBe('PROCESSED');
  });

  it('retries instead of dead-lettering when the Telegram bot is not configured', async () => {
    const tenantId = await setupTenant({ admins: ['7001'] });
    const message = await enqueue(tenantId);

    await dispatcher({}).dispatchOnce();
    const row = await reload(message.id);
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('Bot Telegram non configurato');
  });

  it('renews the lease of each message before delivering it', async () => {
    const first = await enqueue(await setupTenant({ admins: ['7101'] }));
    const second = await enqueue(await setupTenant({ admins: ['7102'] }));
    let secondLockedUntil: Date | null = null;
    let clockAtSecondSend = 0;
    const telegram: TelegramNotifier = {
      async sendDocument(chatId) {
        if (chatId === chat('7101')) advance(50_000); // a slow delivery early in the batch
        if (chatId === chat('7102')) {
          clockAtSecondSend = clock.getTime();
          secondLockedUntil = (await reload(second.id)).lockedUntil;
        }
      },
      sendMessage: () => Promise.resolve(),
    };

    await new OutboxDispatcher(prisma, {
      handlers: [new PracticeExportHandler(prisma, { telegram })],
      batchSize: 500,
      leaseMs: 60_000,
      now,
    }).dispatchOnce();

    expect((await reload(first.id)).status).toBe('PROCESSED');
    expect(secondLockedUntil!.getTime()).toBe(clockAtSecondSend + 60_000);
  });

  it('keeps processing the batch when one message hits a database error', async () => {
    const tenantId = await setupTenant({ admins: ['7201'] });
    const broken = await enqueue(tenantId, 'BROKEN_TARGET');
    const healthy = await enqueue(tenantId);
    const channels = fakeChannels();
    // PostgreSQL rejects NUL bytes in text: recording this target fails with a DatabaseError.
    const brokenHandler = {
      eventType: 'BROKEN_TARGET',
      resolveDeliveries: () =>
        Promise.resolve([
          { target: `bad${String.fromCharCode(0)}`, send: () => Promise.resolve() },
        ]),
    };

    await new OutboxDispatcher(prisma, {
      handlers: [brokenHandler, new PracticeExportHandler(prisma, channels)],
      batchSize: 500,
      now,
    }).dispatchOnce();

    expect((await reload(broken.id)).status).toBe('PROCESSING');
    expect((await reload(healthy.id)).status).toBe('PROCESSED');
  });

  it('fences off a stale claim even after the message was requeued', async () => {
    const tenantId = await setupTenant({ admins: ['7301'] });
    const message = await enqueue(tenantId);
    const repo = new OutboxRepository(prisma);

    const firstClaim = (await repo.claimDue({ now: clock, leaseMs: 60_000, limit: 500 })).find(
      (m) => m.id === message.id,
    )!;
    expect(await repo.moveToDeadLetter(firstClaim, 'test')).toBe(true);
    expect(await repo.requeueDeadLetter(message.id, clock)).toBe(true);

    const secondClaim = (await repo.claimDue({ now: clock, leaseMs: 60_000, limit: 500 })).find(
      (m) => m.id === message.id,
    )!;
    // Same attempt number as the stale claim, different token.
    expect(secondClaim.attempts).toBe(firstClaim.attempts);
    expect(await repo.scheduleRetry(firstClaim, clock, 'stale')).toBe(false);
    expect(await repo.completeClaim(secondClaim, clock)).toBe(true);
  });
});
