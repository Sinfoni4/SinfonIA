/**
 * H10 in the chat: «operatore» (also from the menu) asks for the topic with buttons; the choice
 * records the request. No free text is kept.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ConversationService,
  MENU_BUTTONS,
} from '../src/interface/conversation/conversation.service.js';
import { replyMarkup } from '../src/interface/telegram/telegram.bot.js';

import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { ReplyOptions } from '../src/interface/conversation/conversation.service.js';

const tenant = { id: 't-1', name: 'Cooperativa' } as Tenant;

function setup(result = { created: true, createdAt: new Date('2026-11-04T10:00:00Z') }) {
  const requestAssistance = vi.fn().mockResolvedValue(result);
  const handleMessage = vi.fn().mockResolvedValue('risposta AI');
  const service = new ConversationService(
    { practiceService: { executeCommand: vi.fn() }, handleMessage, requestAssistance },
    {
      name: 'telegram',
      identity: {
        link: () => Promise.resolve(null),
        resolve: () =>
          Promise.resolve({ tenant, userId: 'u-1', role: 'MEMBER', customPermissions: null }),
      },
    },
  );
  const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  const send = (text: string) =>
    service.handle({ senderId: '1', text }, (t, options) => {
      replies.push({ text: t, options });
      return Promise.resolve();
    });
  return { send, replies, requestAssistance, handleMessage };
}

describe('«parla con un operatore» in the chat (H10)', () => {
  it('asks the topic with buttons and records the request', async () => {
    const c = setup();
    await c.send('Parla con un operatore');
    const question = c.replies.at(-1)!;
    expect(question.text).toContain('Su cosa ti serve aiuto?');
    expect(question.options?.buttons?.map((b) => b.label)).toEqual([
      '📁 Una pratica',
      '📄 Un documento',
      '⏰ Una scadenza',
      '💬 Altro',
      'Annulla',
    ]);
    // Pressing a button is writing its answer.
    await c.send(question.options!.buttons![1].answer);
    expect(c.requestAssistance).toHaveBeenCalledWith({
      tenantId: 't-1',
      userId: 'u-1',
      topic: 'DOCUMENT',
      channel: 'TELEGRAM',
    });
    expect(c.replies.at(-1)!.text).toContain('Richiesta inviata');
    expect(c.handleMessage).not.toHaveBeenCalled();
  });

  it('accepts the number or the word of a topic, written by hand', async () => {
    const c = setup();
    await c.send('operatore');
    await c.send('3');
    expect(c.requestAssistance).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic: 'DEADLINE' }),
    );
    await c.send('assistenza');
    await c.send('altro');
    expect(c.requestAssistance).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic: 'OTHER' }),
    );
  });

  it('works from the menu entry', async () => {
    const c = setup();
    const entry = MENU_BUTTONS.find((b) => b.answer === 'operatore')!;
    await c.send(entry.label);
    expect(c.replies.at(-1)!.text).toContain('Su cosa ti serve aiuto?');
  });

  it('says when a request is already open, instead of creating another', async () => {
    const c = setup({ created: false, createdAt: new Date('2026-11-02T10:00:00Z') });
    await c.send('operatore');
    await c.send('1');
    expect(c.replies.at(-1)!.text).toContain(
      'Hai già una richiesta di assistenza aperta dal 02/11/2026',
    );
  });

  it('cancels with «annulla», and any other message goes on as usual', async () => {
    const c = setup();
    await c.send('operatore');
    await c.send('annulla');
    expect(c.replies.at(-1)!.text).toBe('Ok, nessuna richiesta inviata.');
    await c.send('operatore');
    await c.send('come faccio a creare una pratica per la vendemmia?');
    expect(c.requestAssistance).not.toHaveBeenCalled();
    expect(c.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('shows the menu entries two per row on Telegram', () => {
    expect(replyMarkup({ menu: true })).toEqual({
      keyboard: [
        [{ text: '📁 Le mie pratiche' }, { text: '⏰ Le mie scadenze' }],
        [{ text: '🙋 Operatore' }, { text: '🏢 La mia azienda' }],
        [{ text: '❓ Aiuto' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    });
  });
});
