import { describe, expect, it, vi } from 'vitest';

import { DuplicateAttachmentError } from '../src/core/errors/attachment.errors.js';
import { InMemoryConversationMemory } from '../src/interface/conversation/conversation.memory.js';
import {
  formatAttachmentQuestion,
  parseAttachmentSelection,
  readPendingFile,
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

  it('proposes the only open practice, still asking (AGX-01)', () => {
    const target = resolveAttachmentTarget(
      [practice('p1', 'Mario Rossi'), practice('p0', 'Vecchia', 'COMPLETED')],
      '',
    );
    expect(target).toEqual({
      type: 'ask',
      candidates: [practice('p1', 'Mario Rossi')],
      suggested: true,
    });
  });

  it('proposes first the practice named in the caption, ignoring case and accents', () => {
    const target = resolveAttachmentTarget(
      [practice('p1', 'Mario Rossi'), practice('p2', 'Cantina Nicolò')],
      'fattura per cantina NICOLO',
    );
    expect(target).toMatchObject({
      type: 'ask',
      suggested: true,
      candidates: [{ id: 'p2' }, { id: 'p1' }],
    });
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
      suggested: false,
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

describe('parseAttachmentSelection, the question and the stored file', () => {
  it('parses numbers in range and cancellations', () => {
    expect(parseAttachmentSelection('2', 3)).toBe(2);
    expect(parseAttachmentSelection(' 1) ', 3)).toBe(1);
    expect(parseAttachmentSelection('Annulla', 3)).toBe('cancel');
    expect(parseAttachmentSelection('4', 3)).toBeNull();
    expect(parseAttachmentSelection('crea pratica Bianchi', 3)).toBeNull();
  });

  it('takes «sì» as the proposed practice only when there is one', () => {
    expect(parseAttachmentSelection('sì', 2, true)).toBe(1);
    expect(parseAttachmentSelection('Si', 1, true)).toBe(1);
    expect(parseAttachmentSelection('sì', 2, false)).toBeNull();
  });

  it('names the proposed practice in the question', () => {
    expect(formatAttachmentQuestion([practice('p1', 'Mario Rossi')], true)).toContain(
      'Lo associo alla pratica «Mario Rossi»?',
    );
  });

  it('reads back only a well-formed stored file', () => {
    const stored = {
      channel: 'telegram',
      tenantId,
      file: { ref: 'f-1', fileName: 'a.jpg', mimeType: 'image/jpeg' },
      stage: 'choose',
      candidates: [practice('p1', 'Mario Rossi')],
      suggested: true,
      expiresAt: 1,
    };
    expect(readPendingFile(stored)).toMatchObject({ file: { ref: 'f-1' } });
    expect(readPendingFile({ ...stored, stage: 'other' })).toBeNull();
    expect(readPendingFile(null)).toBeNull();
  });
});

describe('Telegram bot: choosing the practice for a received file', () => {
  type Listener = (msg: TelegramMessage) => Promise<void> | void;

  function setup(
    userId: string,
    practices: AttachmentCandidate[],
    maxBytes = 10 * 1024 * 1024,
    memory = new InMemoryConversationMemory(),
  ) {
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
      memory,
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
    return { send, sent, addAttachment, bot, photo, deps };
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

  it('proposes the practice named in the caption and attaches after «sì»', async () => {
    const { send, sent, addAttachment, photo } = setup('user-103', twoPractices);

    await send({ photo, caption: 'fattura di Mario Rossi' });
    expect(addAttachment).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('Lo associo alla pratica «Mario Rossi»?');

    await send({ text: 'sì' });
    expect(addAttachment).toHaveBeenCalledTimes(1);
    expect(addAttachment.mock.calls[0]?.[0]).toMatchObject({
      practiceId: 'p-rossi',
      hint: 'fattura di Mario Rossi',
      channel: 'telegram',
      allowDuplicate: false,
    });
  });

  it('asks even when only one practice is open (AGX-01)', async () => {
    const { send, sent, addAttachment, photo } = setup('user-108', [practice('p-1', 'Unica')]);

    await send({ photo });
    expect(addAttachment).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('Lo associo alla pratica «Unica»?');

    await send({ text: 'annulla' });
    expect(addAttachment).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain('non è stato associato');
  });

  it('keeps the waiting file across a restart and downloads it again from Telegram', async () => {
    const memory = new InMemoryConversationMemory();
    const before = setup('user-109', twoPractices, undefined, memory);
    await before.send({ photo: before.photo });

    // A new process: same database memory, nothing in the process.
    const after = setup('user-109', twoPractices, undefined, memory);
    await after.send({ text: '1' });

    expect(after.addAttachment).toHaveBeenCalledTimes(1);
    expect(after.addAttachment.mock.calls[0]?.[0]).toMatchObject({ practiceId: 'p-rossi' });
    expect(after.bot.getFile).toHaveBeenCalledWith('photo-1');
  });

  it('asks before sending a file already sent, and sends it again only after «sì»', async () => {
    const { send, sent, addAttachment, photo } = setup('user-110', twoPractices);
    addAttachment.mockRejectedValueOnce(
      new DuplicateAttachmentError({
        attachmentId: 'a-1',
        practiceId: 'p-rossi',
        practiceName: 'Mario Rossi',
        uploadedAt: new Date('2026-11-01T10:00:00Z'),
      }),
    );

    await send({ photo });
    await send({ text: '1' });
    expect(sent.at(-1)).toMatch(/Hai già caricato questo file il 0?1\/11\/2026/);
    expect(sent.at(-1)).toContain('Lo carico di nuovo');

    await send({ text: 'sì' });
    expect(addAttachment).toHaveBeenCalledTimes(2);
    expect(addAttachment.mock.calls[1]?.[0]).toMatchObject({
      practiceId: 'p-rossi',
      allowDuplicate: true,
    });
  });

  it('drops a file already sent when the person does not confirm', async () => {
    const { send, sent, addAttachment, photo } = setup('user-111', twoPractices);
    addAttachment.mockRejectedValueOnce(
      new DuplicateAttachmentError({
        attachmentId: 'a-1',
        practiceId: 'p-rossi',
        practiceName: 'Mario Rossi',
        uploadedAt: new Date(),
      }),
    );

    await send({ photo });
    await send({ text: '1' });
    await send({ text: 'no' });

    expect(addAttachment).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toContain('non è stato caricato di nuovo');
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
    await send({ text: 'sì' });
    expect(sent.at(-1)).toContain('invia il documento come File');

    await send({
      document: { file_id: 'doc-3', file_unique_id: 'u', file_name: 'scontrino.jpg' },
      caption: 'scontrino Mario Rossi',
    });
    await send({ text: 'sì' });
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
