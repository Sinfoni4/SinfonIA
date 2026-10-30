import { createHmac, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { COMPLIANCE_DEADLINE_REMINDER } from '../src/core/compliance/compliance.service.js';
import { ComplianceReminderHandler } from '../src/core/outbox/compliance-reminder.handler.js';
import { DeliveryError } from '../src/core/outbox/outbox.delivery.js';
import { provisionTenant } from '../src/core/tenant/tenant.provisioning.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { buildServer } from '../src/interface/http/server.js';
import { attachMessageHandler } from '../src/interface/telegram/telegram.bot.js';
import {
  parseWebhookPayload,
  verifyWebhookSignature,
  WhatsAppChannel,
} from '../src/interface/whatsapp/whatsapp.channel.js';
import { WhatsAppApiError, WhatsAppClient } from '../src/interface/whatsapp/whatsapp.client.js';
import { toWhatsAppDeliveryError } from '../src/interface/whatsapp/whatsapp.notifier.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ContextService } from '../src/ai/context/context.service.js';
import type { ChatNotifier } from '../src/core/outbox/outbox.delivery.js';
import type { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type {
  ChannelIdentityProvider,
  ConversationDeps,
} from '../src/interface/conversation/conversation.service.js';
import type { TelegramClient, TelegramMessage } from '../src/interface/telegram/telegram.client.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

const APP_SECRET = 'whatsapp-test-app-secret';
const VERIFY_TOKEN = 'whatsapp-verify-token-123';
const sign = (body: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex')}`;

/** A webhook delivery as Meta sends it. */
function webhook(...messages: Array<Record<string, unknown>>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'phone-1' },
              messages,
              statuses: [{ id: 'status-1', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
}
const textMessage = (id: string, from: string, body: string) => ({
  id,
  from,
  type: 'text',
  timestamp: '1793210000',
  text: { body },
});

describe('WhatsApp webhook payloads', () => {
  it('verifies the Meta signature on the raw body', () => {
    const body = JSON.stringify(webhook(textMessage('m1', '393331234567', 'ciao')));
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), APP_SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(`${body} `), sign(body), APP_SECRET)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), 'sha256=00', APP_SECRET)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), undefined, APP_SECRET)).toBe(false);
  });

  it('extracts text, photos and documents, and ignores delivery statuses', () => {
    const parsed = parseWebhookPayload(
      webhook(
        textMessage('m1', '39333', 'ciao'),
        {
          id: 'm2',
          from: '39333',
          type: 'image',
          image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'scontrino' },
        },
        {
          id: 'm3',
          from: '39333',
          type: 'document',
          document: { id: 'media-2', mime_type: 'application/pdf', filename: 'fattura.pdf' },
        },
        { id: 'm4', from: '39333', type: 'audio', audio: { id: 'media-3' } },
      ),
    );
    expect(parsed.map((m) => [m.id, m.type, m.text, m.media?.id ?? null])).toEqual([
      ['m1', 'text', 'ciao', null],
      ['m2', 'image', 'scontrino', 'media-1'],
      ['m3', 'document', '', 'media-2'],
      ['m4', 'audio', '', null],
    ]);
    expect(parsed[2]?.media).toMatchObject({ filename: 'fattura.pdf', isPhoto: false });
  });
});

describe('WhatsApp webhook routes', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '3015',
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
    SERVICE_NAME: 'sinfonia-whatsapp-test',
    ...TEST_AUTH_ENV,
  });
  const onPayload = vi.fn(() => Promise.resolve());
  const createPractice = vi.fn().mockResolvedValue({ id: 'p1', name: 'Prova' });
  const practiceService = { createPractice } as unknown as PracticeApplicationService;
  const app = buildServer(config, createLogger(config), {
    principals: testPrincipals(),
    practiceService,
    whatsappWebhook: { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, onPayload },
    interpreterService: new InterpreterService({ complete: vi.fn() }),
    executorService: new ExecutorService({ practiceService }),
    contextService: {} as ContextService,
    decisionEngine: new DecisionEngine(),
    normalizerService: new NormalizerService(),
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the subscription handshake only with the right verify token', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=4242`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('4242');

    const wrong = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=4242',
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('rejects a delivery with an invalid signature and does not process it', async () => {
    const body = JSON.stringify(webhook(textMessage('m1', '39333', 'ciao')));
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it('accepts a signed delivery and hands the parsed payload over', async () => {
    const body = JSON.stringify(webhook(textMessage('m1', '39333', 'ciao')));
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(onPayload).toHaveBeenCalledWith(JSON.parse(body));
  });

  it('leaves JSON parsing of the other routes untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/practices',
      headers: {
        ...authHeaders(randomUUID(), randomUUID(), 'ADMIN'),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'Prova' }),
    });
    expect(res.statusCode).toBe(201);
    expect(createPractice).toHaveBeenCalledWith(expect.objectContaining({ name: 'Prova' }));
  });
});

describe('WhatsApp client and delivery errors', () => {
  it('sends text with the access token and parses Graph API errors', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }),
      ),
    );
    const client = new WhatsAppClient({ accessToken: 'tok', phoneNumberId: 'phone-1', fetchImpl });
    await client.sendText('393331234567', 'ciao');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/phone-1/messages');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '393331234567',
      type: 'text',
      text: { body: 'ciao' },
    });

    const failing = new WhatsAppClient({
      accessToken: 'tok',
      phoneNumberId: 'phone-1',
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }),
            {
              status: 400,
            },
          ),
        ),
    });
    await expect(failing.sendText('39333', 'ciao')).rejects.toMatchObject({
      code: 131047,
      status: 400,
    });
  });

  it('uploads a document, then sends it by media id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'media-9' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    const client = new WhatsAppClient({ accessToken: 'tok', phoneNumberId: 'phone-1', fetchImpl });
    await client.sendDocument(
      '39333',
      { filename: 'export.csv', content: Buffer.from('a;b'), mimeType: 'text/csv' },
      'Export',
    );
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
      'https://graph.facebook.com/v21.0/phone-1/media',
    );
    const sent = JSON.parse(
      (fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { document: unknown };
    expect(sent.document).toEqual({ id: 'media-9', filename: 'export.csv', caption: 'Export' });
  });

  it.each([
    [new WhatsAppApiError('outside window', 400, 131047), true, '24 ore'],
    [new WhatsAppApiError('rate limited', 400, 130429), false, ''],
    [new WhatsAppApiError('server error', 503), false, ''],
    [new WhatsAppApiError('invalid number', 400, 131026), true, ''],
  ])('maps %s to a delivery error', (err, permanent, text) => {
    const mapped = toWhatsAppDeliveryError(err) as DeliveryError;
    expect(mapped).toBeInstanceOf(DeliveryError);
    expect(mapped.permanent).toBe(permanent);
    expect(mapped.message).toContain(text);
  });
});

// Shared fakes for the conversation tests: same services, same identity, different channels.
const tenant = { id: '11111111-1111-4111-8111-111111111111', name: 'Coop' } as Tenant;
function fakeConversationDeps() {
  const practices = [
    { id: 'p-rossi', name: 'Mario Rossi', status: 'CREATED' },
    { id: 'p-bianchi', name: 'Anna Bianchi', status: 'CREATED' },
  ];
  return {
    practiceService: {
      executeCommand: vi.fn().mockResolvedValue({ type: 'list', practices }),
      listPractices: vi.fn().mockResolvedValue(practices),
      getMaxAttachmentBytes: () => 10 * 1024 * 1024,
      addAttachment: vi.fn().mockResolvedValue({
        attachment: { ocrStatus: 'COMPLETED' },
        ocrResult: {
          documentType: 'receipt',
          merchantName: 'Bar Centrale',
          merchantVat: '01122334459',
          documentDate: '2026-10-25',
          totalAmount: 45.8,
          missingFields: [],
          warnings: [],
          reviewRequired: false,
        },
      }),
    },
    handleMessage: vi.fn().mockResolvedValue('risposta AI'),
  } as unknown as ConversationDeps;
}
const linkedIdentity: ChannelIdentityProvider = {
  link: () => Promise.resolve(tenant.id),
  resolve: () => Promise.resolve({ tenant, userId: 'u-1', role: 'ADMIN' }),
};

function fakeWhatsAppClient() {
  const sent: string[] = [];
  return {
    sent,
    client: {
      sendText: vi.fn((_to: string, text: string) => {
        sent.push(text);
        return Promise.resolve();
      }),
      getMedia: vi.fn(() => Promise.resolve({ url: 'https://lookaside.example/media-1' })),
      downloadMedia: vi.fn(() => Promise.resolve(Buffer.from('jpeg-bytes'))),
    },
  };
}

describe('conversation parity between Telegram and WhatsApp', () => {
  it('gives the same replies to the same messages', async () => {
    // WhatsApp
    const wa = fakeWhatsAppClient();
    const waDeps = fakeConversationDeps();
    const channel = new WhatsAppChannel(
      wa.client,
      { ...waDeps, prisma: {} as PrismaClient },
      undefined,
      linkedIdentity,
    );
    let n = 0;
    const waSend = (fields: Record<string, unknown>) =>
      channel.receive(
        webhook({ id: `wa-${++n}`, from: '393331234567', timestamp: '1', ...fields }),
      );

    // Telegram
    let listener: ((msg: TelegramMessage) => Promise<void>) | undefined;
    const tgSent: string[] = [];
    const bot = {
      on: (_event: string, cb: (msg: TelegramMessage) => Promise<void>) => {
        listener = cb;
      },
      sendMessage: vi.fn((_chat: number, text: string) => {
        tgSent.push(text);
        return Promise.resolve();
      }),
      getFile: vi.fn(() => Promise.resolve({ file_id: 'f', file_path: 'photos/f.jpg' })),
      downloadFile: vi.fn(() => Promise.resolve(Buffer.from('jpeg-bytes'))),
    };
    const tgDeps = fakeConversationDeps();
    attachMessageHandler(bot as unknown as TelegramClient, {
      ...tgDeps,
      prisma: {} as PrismaClient,
      identity: linkedIdentity,
    });
    let m = 0;
    const tgSend = (fields: Partial<TelegramMessage>) =>
      listener!({
        message_id: ++m,
        date: 0,
        chat: { id: 1, type: 'private' },
        from: { id: 393331234567, is_bot: false },
        ...fields,
      });

    // Same conversation on both channels.
    await waSend({ type: 'text', text: { body: 'lista pratiche' } });
    await tgSend({ text: 'lista pratiche' });
    await waSend({ type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } });
    await tgSend({ photo: [{ file_id: 'f', file_unique_id: 'u', width: 800, height: 600 }] });
    await waSend({ type: 'text', text: { body: '2' } });
    await tgSend({ text: '2' });
    await waSend({ type: 'text', text: { body: 'quanto ho speso questo mese?' } });
    await tgSend({ text: 'quanto ho speso questo mese?' });

    expect(wa.sent).toHaveLength(4);
    expect(wa.sent).toEqual(tgSent);
    expect(wa.sent[1]).toContain('A quale pratica lo associo?');
    expect(wa.sent[2]).toContain('📁 Pratica: Anna Bianchi');
    expect(wa.sent[3]).toBe('risposta AI');
    // The photo was fetched through the Cloud API media endpoints.
    expect(wa.client.getMedia).toHaveBeenCalledWith('media-1');
    expect(waDeps.practiceService.addAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ practiceId: 'p-bianchi', content: Buffer.from('jpeg-bytes') }),
    );
  });
});

describeWithDb('WhatsApp channel with PostgreSQL (Step 7)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('links a phone number with an invite code, then knows the sender', async () => {
    const { tenantId, inviteCode } = await provisionTenant(prisma, {
      name: `t-wa-${randomUUID()}`,
    });
    const phone = `39${String(Date.now()).slice(-9)}`;
    const wa = fakeWhatsAppClient();
    const deps = fakeConversationDeps();
    const channel = new WhatsAppChannel(wa.client, { ...deps, prisma });

    await channel.receive(webhook(textMessage('l1', phone, 'lista pratiche')));
    expect(wa.sent.at(-1)).toContain('non è ancora collegato');

    await channel.receive(webhook(textMessage('l2', phone, `start ${inviteCode}`)));
    expect(wa.sent.at(-1)).toContain('Sei stato collegato');
    const identity = await prisma.whatsappIdentity.findFirst({ where: { phoneNumber: phone } });
    expect(identity?.tenantId).toBe(tenantId);

    await channel.receive(webhook(textMessage('l3', phone, 'lista pratiche')));
    expect(deps.practiceService.executeCommand).toHaveBeenCalledWith(
      { type: 'LIST_PRACTICES', payload: {} },
      { tenantId, userId: identity!.userId, role: 'MEMBER' },
      { channel: 'whatsapp' },
    );
  });

  it('processes a message delivered twice by Meta only once', async () => {
    const wa = fakeWhatsAppClient();
    const channel = new WhatsAppChannel(
      wa.client,
      { ...fakeConversationDeps(), prisma },
      undefined,
      linkedIdentity,
    );
    const payload = webhook(textMessage('dup-1', '39333', 'lista pratiche'));
    await channel.receive(payload);
    await channel.receive(payload);
    expect(wa.sent).toHaveLength(1);
  });

  it('explains which message types are supported', async () => {
    const wa = fakeWhatsAppClient();
    const channel = new WhatsAppChannel(
      wa.client,
      { ...fakeConversationDeps(), prisma },
      undefined,
      linkedIdentity,
    );
    await channel.receive(webhook({ id: 'a1', from: '39333', type: 'audio', audio: { id: 'x' } }));
    // Voice messages get their own answer: not transcribed yet.
    expect(wa.sent.at(-1)).toContain('messaggi vocali non sono ancora supportati');
  });

  it('delivers deadline reminders to the admins linked on WhatsApp', async () => {
    const { tenantId, inviteCode } = await provisionTenant(prisma, {
      name: `t-wa-rem-${randomUUID()}`,
    });
    const phone = `39${String(Date.now() + 7).slice(-9)}`;
    const wa = fakeWhatsAppClient();
    await new WhatsAppChannel(wa.client, { ...fakeConversationDeps(), prisma }).receive(
      webhook(textMessage('r1', phone, `start ${inviteCode}`)),
    );
    // Linked users start as MEMBER: promote to ADMIN, as an administrator would.
    const identity = await prisma.whatsappIdentity.findFirstOrThrow({
      where: { phoneNumber: phone },
    });
    await prisma.user.update({ where: { id: identity.userId }, data: { role: 'ADMIN' } });

    const sent: Array<[string, string]> = [];
    const whatsapp: ChatNotifier = {
      sendDocument: () => Promise.resolve(),
      sendMessage: (to, text) => {
        sent.push([to, text]);
        return Promise.resolve();
      },
    };
    const deliveries = await new ComplianceReminderHandler(prisma, { whatsapp }).resolveDeliveries({
      id: randomUUID(),
      tenantId,
      eventType: COMPLIANCE_DEADLINE_REMINDER,
      payload: {
        deadlineId: randomUUID(),
        category: 'DURC',
        title: 'DURC cooperativa',
        dueDate: '2026-11-02',
        daysLeft: 5,
        thresholdDays: 7,
        userId: null,
      },
      attempts: 1,
      claimToken: randomUUID(),
      deliveredTargets: [],
      createdAt: new Date(),
    });
    expect(deliveries.map((d) => d.target)).toEqual([`whatsapp:${phone}`]);
    for (const delivery of deliveries) await delivery.send();
    expect(sent[0]?.[1]).toContain('scade tra 5 giorni');
  });
});
