/**
 * Typing errors in chat commands: the closest command is found on its fixed words; a certain
 * error on a read-only command is corrected at once, anything else waits for «sì»; sentences
 * still go to the AI. Voice messages get an explicit answer.
 */
import { describe, expect, it, vi } from 'vitest';

import { parseComplianceCommand } from '../src/core/compliance/compliance.commands.js';
import { parsePracticeCommand } from '../src/core/practice/practice.commands.js';
import { suggestCommand } from '../src/interface/conversation/command.typos.js';
import {
  ConversationService,
  VOICE_NOT_SUPPORTED,
} from '../src/interface/conversation/conversation.service.js';

import type { Tenant } from '../src/core/tenant/tenant.store.js';

const SCHEDULED = /^(attiva|disattiva)\s+export\s+pianificato$/i;
const isCommand = (t: string) =>
  SCHEDULED.test(t) || parseComplianceCommand(t) !== null || parsePracticeCommand(t) !== null;
const suggest = (t: string) => suggestCommand(t, isCommand);

describe('command suggestions', () => {
  it('corrects one-character errors of read-only commands', () => {
    expect(suggest('Scadenzi')).toMatchObject({
      corrected: 'scadenze',
      readOnly: true,
      distance: 1,
    });
    expect(suggest('lsta pratiche')).toMatchObject({ corrected: 'lista pratiche', distance: 1 });
    expect(suggest('pratihce azienda')).toMatchObject({ corrected: 'pratiche azienda' });
    // Only the fixed words are corrected: names keep their spelling.
    expect(suggest('stato pratca Mario Rossi')?.corrected).toBe('stato pratica Mario Rossi');
  });

  it('marks commands that change data as needing confirmation', () => {
    expect(suggest('elimna pratica Mario Rossi')).toMatchObject({
      corrected: 'elimina pratica Mario Rossi',
      readOnly: false,
    });
    expect(suggest('attiva export pianificat')).toMatchObject({ readOnly: false });
  });

  it('leaves commands, sentences and incomplete commands alone', () => {
    for (const text of [
      'scadenze',
      'lista pratiche',
      'crea pratica per Mario Rossi',
      'valida la pratica di Mario Rossi',
      'ciao',
      'come sta andando la pratica di Anna?',
      'stato pratiche',
    ]) {
      expect(suggest(text), text).toBeNull();
    }
  });
});

describe('typing errors in the chat', () => {
  const tenant = { id: 't-1', name: 'Cooperativa' } as Tenant;

  const setup = () => {
    const executeCommand = vi.fn().mockResolvedValue({ type: 'list', practices: [] });
    const listDeadlines = vi.fn().mockResolvedValue([]);
    const handleMessage = vi.fn().mockResolvedValue('risposta AI');
    const service = new ConversationService(
      {
        practiceService: { executeCommand },
        complianceService: {
          listDeadlines,
          createDeadline: vi.fn(),
          closeDeadline: vi.fn(),
        },
        handleMessage,
      },
      {
        name: 'telegram',
        identity: {
          link: () => Promise.resolve(null),
          resolve: () => Promise.resolve({ tenant, userId: 'u-1', role: 'ADMIN' }),
        },
      },
    );
    const replies: string[] = [];
    const say = (text: string) =>
      service.handle({ senderId: '1', text }, (t) => {
        replies.push(t);
        return Promise.resolve();
      });
    return { say, replies, executeCommand, listDeadlines, handleMessage };
  };

  it('runs «Scadenzi» as «scadenze», saying so, without the AI', async () => {
    const c = setup();
    await c.say('Scadenzi');
    expect(c.replies[0]).toBe('🔎 Ho inteso «scadenze».');
    expect(c.listDeadlines).toHaveBeenCalledTimes(1);
    expect(c.handleMessage).not.toHaveBeenCalled();
  });

  it('asks before a command that changes data, and runs it only after «sì»', async () => {
    const c = setup();
    await c.say('elimna pratica Prova');
    expect(c.replies.at(-1)).toContain('Intendevi «elimina pratica Prova»?');
    expect(c.executeCommand).not.toHaveBeenCalled();
    await c.say('sì');
    expect(c.executeCommand).toHaveBeenCalledWith(
      { type: 'DELETE_PRACTICE', payload: { name: 'Prova' } },
      { tenantId: 't-1', userId: 'u-1', role: 'ADMIN' },
      { channel: 'telegram' },
    );
  });

  it('drops the suggestion when the answer is something else', async () => {
    const c = setup();
    await c.say('elimna pratica Prova');
    await c.say('no, lascia stare');
    expect(c.executeCommand).not.toHaveBeenCalled();
    expect(c.handleMessage).toHaveBeenCalledWith('no, lascia stare', expect.anything());
  });

  it('has an explicit answer for voice messages', () => {
    expect(VOICE_NOT_SUPPORTED).toContain('messaggi vocali non sono ancora supportati');
  });
});
