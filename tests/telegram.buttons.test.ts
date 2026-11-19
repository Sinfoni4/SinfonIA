/**
 * A2 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.3): buttons under the bot's questions and the
 * main menu. A pressed button is the same as writing its answer, once, from the person who
 * pressed it; the menu entries are commands the bot already understands.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ConversationService,
  MENU_BUTTONS,
  type ChatAnswer,
  type ReplyOptions,
} from '../src/interface/conversation/conversation.service.js';
import {
  attachMessageHandler,
  ButtonAnswers,
  replyMarkup,
} from '../src/interface/telegram/telegram.bot.js';

import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type {
  TelegramCallbackQuery,
  TelegramClient,
  TelegramMessage,
} from '../src/interface/telegram/telegram.client.js';
import type { PrismaClient } from '@prisma/client';

const tenant = { id: 't-1', name: 'Cooperativa' } as Tenant;
const identity = {
  link: () => Promise.resolve(null),
  resolve: () =>
    Promise.resolve({ tenant, userId: 'u-1', role: 'ADMIN' as const, customPermissions: null }),
};

describe('button answers and markup', () => {
  it('gives each answer once, and nothing for unknown or old buttons', () => {
    const answers = new ButtonAnswers(2);
    answers.remember(1, 10, ['sì', 'no']);
    expect(answers.take(1, 10, 'b1')).toBe('no');
    expect(answers.take(1, 10, 'b0')).toBeNull();
    answers.remember(1, 11, ['a']);
    answers.remember(1, 12, ['b']);
    answers.remember(1, 13, ['c']);
    // Capacity 2: the oldest is forgotten.
    expect(answers.take(1, 11, 'b0')).toBeNull();
    expect(answers.take(1, 13, 'b0')).toBe('c');
    expect(answers.take(1, 12, 'x9')).toBeNull();
  });

  it('puts short buttons two per row and long ones alone; the menu is persistent', () => {
    expect(
      replyMarkup({
        buttons: [
          { label: 'Sì', answer: 'sì' },
          { label: 'No', answer: 'no' },
          { label: 'Controlla stato pratiche', answer: 'Controlla stato pratiche' },
        ],
      }),
    ).toEqual({
      inline_keyboard: [
        [
          { text: 'Sì', callback_data: 'b0' },
          { text: 'No', callback_data: 'b1' },
        ],
        [{ text: 'Controlla stato pratiche', callback_data: 'b2' }],
      ],
    });
    expect(replyMarkup({ menu: true })).toMatchObject({
      is_persistent: true,
      resize_keyboard: true,
    });
    expect(replyMarkup(undefined)).toBeUndefined();
  });
});

function conversation(answers: Array<string | ChatAnswer> = []) {
  const executeCommand = vi.fn().mockResolvedValue({ type: 'list', practices: [] });
  const handleMessage = vi.fn();
  for (const a of answers) handleMessage.mockResolvedValueOnce(a);
  handleMessage.mockResolvedValue('risposta AI');
  const service = new ConversationService(
    {
      practiceService: { executeCommand },
      complianceService: {
        listDeadlines: vi.fn().mockResolvedValue([]),
        createDeadline: vi.fn(),
        closeDeadline: vi.fn(),
      },
      handleMessage,
    },
    { name: 'telegram', identity, reviewUrl: 'https://app.sinfonia.test/app/verifica' },
  );
  const sent: Array<{ text: string; options?: ReplyOptions }> = [];
  const say = (text: string) =>
    service.handle({ senderId: '1', text }, (t, options) => {
      sent.push({ text: t, options });
      return Promise.resolve();
    });
  return { say, sent, executeCommand, handleMessage };
}

describe('buttons in the conversation', () => {
  it('turns the options of a question of the AI into buttons', async () => {
    const c = conversation([
      {
        text: 'Cosa vuoi fare?',
        clarification: { options: ['Crea nuova pratica', 'Valida pratica'] },
      },
    ]);
    await c.say('Scontrino 001');
    expect(c.sent[0].options?.buttons).toEqual([
      { label: 'Crea nuova pratica', answer: 'Crea nuova pratica' },
      { label: 'Valida pratica', answer: 'Valida pratica' },
    ]);
  });

  it('offers Sì / No on a suggested command', async () => {
    const c = conversation();
    await c.say('elimna pratica Prova');
    expect(c.sent[0].options?.buttons?.map((b) => b.answer)).toEqual(['sì', 'no']);
  });

  it('shows the menu on /start and «aiuto», and runs its entries as commands', async () => {
    const c = conversation();
    await c.say('/start');
    expect(c.sent.at(-1)?.options).toEqual({ menu: true });
    await c.say('❓ Aiuto');
    expect(c.sent.at(-1)?.options).toEqual({ menu: true });
    await c.say(MENU_BUTTONS[0].label);
    expect(c.executeCommand).toHaveBeenCalledWith(
      { type: 'LIST_PRACTICES', payload: {} },
      expect.anything(),
      { channel: 'telegram' },
    );
    expect(c.handleMessage).not.toHaveBeenCalled();
  });
});

describe('a document read with doubts', () => {
  it('offers Conferma / Modifica; Modifica points to the dashboard', async () => {
    const addAttachment = vi.fn().mockResolvedValue({
      attachment: { id: 'a-1', ocrStatus: 'COMPLETED' },
      ocrResult: {
        documentType: 'receipt',
        merchantName: 'Bar',
        merchantVat: null,
        documentDate: null,
        totalAmount: 1,
        currency: 'EUR',
        missingFields: ['merchantVat'],
        warnings: [],
        reviewRequired: true,
      },
    });
    const service = new ConversationService(
      {
        practiceService: {
          executeCommand: vi.fn(),
          addAttachment,
          listPractices: vi
            .fn()
            .mockResolvedValue([{ id: 'p-1', name: 'Prova', status: 'CREATED' }]),
        },
        handleMessage: vi.fn(),
        confirmDocument: vi.fn(),
      },
      { name: 'telegram', identity, reviewUrl: 'https://app.sinfonia.test/app/verifica' },
    );
    const sent: Array<{ text: string; options?: ReplyOptions }> = [];
    const reply = (t: string, options?: ReplyOptions) => {
      sent.push({ text: t, options });
      return Promise.resolve();
    };
    await service.handle(
      {
        senderId: '1',
        text: '',
        file: {
          fileName: 'x.jpg',
          mimeType: 'image/jpeg',
          download: () => Promise.resolve(Buffer.from('x')),
        },
      },
      reply,
    );
    // AGX-01: the only practice is proposed, with a button, and the file waits for the answer.
    expect(sent[0].options?.buttons?.map((b) => b.answer)).toEqual(['1', 'annulla']);
    expect(addAttachment).not.toHaveBeenCalled();
    await service.handle({ senderId: '1', text: '1' }, reply);
    expect(sent[1].options?.buttons?.map((b) => b.answer)).toEqual(['conferma', 'modifica']);
    await service.handle({ senderId: '1', text: 'modifica' }, reply);
    expect(sent[2].text).toContain('https://app.sinfonia.test/app/verifica');
  });
});

describe('pressing a button in Telegram', () => {
  it('answers as if the person had written it, once', async () => {
    const listeners = new Map<string, (value: never) => Promise<void>>();
    let nextId = 100;
    const bot = {
      on: (event: string, cb: (value: never) => Promise<void>) => {
        listeners.set(event, cb);
        return bot;
      },
      sendMessage: vi.fn((chatId: number, text: string) =>
        Promise.resolve({ message_id: ++nextId, chat: { id: chatId, type: 'private' }, text }),
      ),
      answerCallbackQuery: vi.fn(() => Promise.resolve()),
      clearInlineKeyboard: vi.fn(() => Promise.resolve()),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const handleMessage = vi
      .fn()
      .mockResolvedValueOnce({ text: 'Quale?', clarification: { options: ['Valida pratica'] } })
      .mockResolvedValue('fatto');
    attachMessageHandler(bot as unknown as TelegramClient, {
      prisma: {} as PrismaClient,
      identity,
      practiceService: { executeCommand: vi.fn() },
      handleMessage,
    });
    const message = listeners.get('message') as unknown as (m: TelegramMessage) => Promise<void>;
    const press = listeners.get('callback_query') as unknown as (
      q: TelegramCallbackQuery,
    ) => Promise<void>;
    await message({
      message_id: 1,
      date: 0,
      text: 'Scontrino 001',
      chat: { id: 7, type: 'private' },
      from: { id: 42, is_bot: false },
    });
    const [, , options] = bot.sendMessage.mock.calls[0] as unknown as [
      number,
      string,
      { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } },
    ];
    expect(options.reply_markup.inline_keyboard[0][0].callback_data).toBe('b0');

    const query = {
      id: 'q1',
      from: { id: 42, is_bot: false },
      message: { message_id: 101, chat: { id: 7, type: 'private' } },
      data: 'b0',
    };
    await press(query);
    expect(handleMessage).toHaveBeenLastCalledWith('Valida pratica', expect.anything());
    expect(bot.clearInlineKeyboard).toHaveBeenCalledWith(7, 101);
    await press({ ...query, id: 'q2' });
    expect(bot.answerCallbackQuery).toHaveBeenLastCalledWith(
      'q2',
      'Pulsante scaduto: scrivi la risposta.',
    );
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });
});
