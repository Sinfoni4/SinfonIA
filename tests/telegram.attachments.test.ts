import { describe, expect, it, vi } from 'vitest';

import {
  PendingAttachmentStore,
  parseAttachmentSelection,
  resolveAttachmentTarget,
  type AttachmentCandidate,
} from '../src/interface/telegram/telegram.attachment-target.js';
import { attachMessageHandler, type BotDeps } from '../src/interface/telegram/telegram.bot.js';

import type { TelegramClient, TelegramMessage } from '../src/interface/telegram/telegram.client.js';
import type { PrismaClient } from '@prisma/client';

const tenantId = '11111111-1111-4111-8111-111111111111';

const practice = (id: string, name: string, status = 'CREATED'): AttachmentCandidate =>
  ({ id, name, status }) as AttachmentCandidate;

describe('resolveAttachmentTarget', () => {
  it('returns none when the user has no practices', () => {
    expect(resolveAttachmentTarget([], '')).toEqual({ type: 'none' });
  });

  it('selects the only open practice without asking', () => {
    const target = resolveAttachmentTarget(
      [practice('p1', 'Mario Rossi'), practice('p0', 'Vecchia', 'COMPLETED')],
      '',
    );
    expect(target).toEqual({ type: 'selected', practice: practice('p1', 'Mario Rossi') });
  });

  it('selects the practice named in the caption, ignoring case and accents', () => {
    const target = resolveAttachmentTarget(
      [practice('p1', 'Mario Rossi'), practice('p2', 'Cantina Nicolò')],
      'fattura per cantina NICOLO',
    );
    expect(target).toMatchObject({ type: 'selected', practice: { id: 'p2' } });
  });

  it('matches the caption on whole words only', () => {
    const target = resolveAttachmentTarget(
      [practice('p1', 'Rossi'), practice('p2', 'Bianchi')],
      'fattura Rossini',
    );
    expect(target.type).toBe('ask');
  });

  it('never picks a closed practice without asking', () => {
    const target = resolveAttachmentTarget([practice('p0', 'Vecchia', 'COMPLETED')], '');
    expect(target).toEqual({
      type: 'ask',
      candidates: [practice('p0', 'Vecchia', 'COMPLETED')],
    });
  });

  it('asks when more than one practice is possible, listing at most five', () => {
    const practices = Array.from({ length: 7 }, (_, i) => practice(`p${i}`, `Pratica ${i}`));
    const target = resolveAttachmentTarget(practices, 'ecco il documento');
    expect(target.type).toBe('ask');
    expect(target.type === 'ask' && target.candidates.map((c) => c.id)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });
});

describe('parseAttachmentSelection and PendingAttachmentStore', () => {
  it('parses numbers in range and cancellations', () => {
    expect(parseAttachmentSelection('2', 3)).toBe(2);
    expect(parseAttachmentSelection(' 1) ', 3)).toBe(1);
    expect(parseAttachmentSelection('Annulla', 3)).toBe('cancel');
    expect(parseAttachmentSelection('4', 3)).toBeNull();
    expect(parseAttachmentSelection('crea pratica Bianchi', 3)).toBeNull();
  });

  it('expires pending files after the TTL', () => {
    let now = 1_000;
    const store = new PendingAttachmentStore(60_000, () => now);
    store.set('u1', { fileId: 'f', fileName: 'a.jpg', mimeType: 'image/jpeg' }, []);
    expect(store.get('u1')).not.toBeNull();
    now += 60_001;
    expect(store.get('u1')).toBeNull();
  });
});

describe('Telegram bot: choosing the practice for a received file', () => {
  type Listener = (msg: TelegramMessage) => Promise<void> | void;

  function setup(userId: string, practices: AttachmentCandidate[], maxBytes = 10 * 1024 * 1024) {
    let listener: Listener | undefined;
    const sent: string[] = [];
    const bot = {
      on: (event: string, fn: Listener) => {
        if (event === 'message') listener = fn;
        return bot;
      },
      sendMessage: vi.fn((_chatId: number, text: string) => {
        sent.push(text);
        return Promise.resolve();
      }),
      getFile: vi.fn(() => Promise.resolve({ file_id: 'f', file_path: 'photos/f.jpg' })),
      downloadFile: vi.fn(() => Promise.resolve(Buffer.from('jpeg'))),
    };

    const prisma = {
      // Chat identity (MF4): an active Telegram link to a person with one membership.
      channelIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          userId,
          user: {
            memberships: [{ orgId: tenantId, role: 'MEMBER', org: { name: 'Cooperativa Test' } }],
          },
        }),
      },
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          id: tenantId,
          name: 'Cooperativa Test',
          module: 'music',
          integrationType: 'none',
          schedulerEnabled: false,
          schedulerFrequency: null,
          schedulerTasks: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    } as unknown as PrismaClient;

    const addAttachment = vi.fn().mockResolvedValue({
      attachment: { ocrStatus: 'COMPLETED' },
      ocrResult: undefined,
    });
    const deps = {
      prisma,
      practiceService: {
        executeCommand: vi.fn(),
        listPractices: vi.fn().mockResolvedValue(practices),
        addAttachment,
        getMaxAttachmentBytes: () => maxBytes,
      },
      handleMessage: vi.fn().mockResolvedValue('ok'),
    } as unknown as BotDeps;

    attachMessageHandler(bot as unknown as TelegramClient, deps);

    let messageId = 0;
    const send = async (fields: Partial<TelegramMessage>) => {
      await listener?.({
        message_id: ++messageId,
        date: 0,
        chat: { id: 1, type: 'private' },
        from: { id: Number(userId.replace(/\D/g, '').slice(0, 9)), is_bot: false },
        ...fields,
      });
    };
    const photo = [{ file_id: 'photo-1', file_unique_id: 'u', width: 800, height: 600 }];
    return { send, sent, addAttachment, bot, photo };
  }

  const twoPractices = [practice('p-rossi', 'Mario Rossi'), practice('p-bianchi', 'Anna Bianchi')];

  it('asks which practice to use, then attaches to the chosen one', async () => {
    const { send, sent, addAttachment, photo } = setup('user-101', twoPractices);

    await send({ photo });
    expect(addAttachment).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('A quale pratica lo associo?');
    expect(sent.at(-1)).toContain('2) Anna Bianchi');

    await send({ text: '2' });
    expect(addAttachment).toHaveBeenCalledTimes(1);
    const uploaded = addAttachment.mock.calls[0]?.[0] as { practiceId: string; fileName: string };
    expect(uploaded.practiceId).toBe('p-bianchi');
    expect(uploaded.fileName).toMatch(/^photo_\d+\.jpg$/);
    expect(sent.at(-1)).toContain('📁 Pratica: Anna Bianchi');
  });

  it('does not attach anything when the user cancels', async () => {
    const { send, sent, addAttachment, bot, photo } = setup('user-102', twoPractices);

    await send({ photo });
    await send({ text: 'annulla' });

    expect(addAttachment).not.toHaveBeenCalled();
    expect(bot.downloadFile).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('non è stato associato');
  });

  it('attaches directly when the caption names the practice', async () => {
    const { send, addAttachment, photo } = setup('user-103', twoPractices);

    await send({ photo, caption: 'fattura di Mario Rossi' });

    expect(addAttachment).toHaveBeenCalledTimes(1);
    expect(addAttachment.mock.calls[0]?.[0]).toMatchObject({
      practiceId: 'p-rossi',
      hint: 'fattura di Mario Rossi',
    });
  });

  it('suggests sending a file when a compressed photo needs review', async () => {
    const { send, sent, addAttachment, photo } = setup('user-107', twoPractices);
    const weakRead = {
      attachment: { ocrStatus: 'COMPLETED' },
      ocrResult: {
        documentType: 'receipt',
        merchantName: null,
        merchantVat: null,
        documentDate: null,
        totalAmount: null,
        missingFields: ['merchantName', 'merchantVat', 'documentDate', 'totalAmount'],
        warnings: [],
        reviewRequired: true,
      },
    };
    addAttachment.mockResolvedValue(weakRead);

    await send({ photo, caption: 'scontrino Mario Rossi' });
    expect(sent.at(-1)).toContain('invia il documento come File');

    await send({
      document: { file_id: 'doc-3', file_unique_id: 'u', file_name: 'scontrino.jpg' },
      caption: 'scontrino Mario Rossi',
    });
    expect(sent.at(-1)).not.toContain('invia il documento come File');
  });

  it('explains what to do when there is no practice yet', async () => {
    const { send, sent, addAttachment, photo } = setup('user-104', []);

    await send({ photo });

    expect(addAttachment).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('Crea prima una pratica');
  });

  it('rejects oversized files before asking or downloading', async () => {
    const { send, sent, addAttachment, bot } = setup('user-105', twoPractices);

    await send({
      document: {
        file_id: 'doc-1',
        file_unique_id: 'u',
        file_name: 'enorme.pdf',
        file_size: 50 * 1024 * 1024,
      },
    });

    expect(addAttachment).not.toHaveBeenCalled();
    expect(bot.getFile).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('troppo grande');
  });

  it('rejects files above the Telegram download limit even with a higher configured limit', async () => {
    const { send, sent, bot } = setup('user-106', twoPractices, 50 * 1024 * 1024);

    await send({
      document: {
        file_id: 'doc-2',
        file_unique_id: 'u',
        file_name: 'grande.pdf',
        file_size: 25 * 1024 * 1024,
      },
    });

    expect(bot.getFile).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('troppo grande');
  });
});
