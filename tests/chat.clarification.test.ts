/**
 * Answers to a question of the AI (Telegram, 31/10/2026): «Crea nuova pratica» → «Qual è il nome?»
 * → «Scontrino 001» used to start over with a new question, in a loop. Now a short answer completes
 * the request the AI asked about; commands, offered options and long sentences are new requests.
 */
import { describe, expect, it, vi } from 'vitest';

import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import {
  validateBeforeDecision,
  validateResolvedCommand,
} from '../src/ai/validation/pre-execution.validator.js';
import {
  ConversationService,
  type ChatAnswer,
} from '../src/interface/conversation/conversation.service.js';
import { TelegramAdapter } from '../src/interface/telegram/telegram.adapter.js';
import { formatTelegramResponse } from '../src/interface/telegram/telegram.formatter.js';

import type { Tenant } from '../src/core/tenant/tenant.store.js';

const tenant = { id: 't-1', name: 'Cooperativa' } as Tenant;

const question = (text: string, options: string[] = []): ChatAnswer => ({
  text,
  clarification: { options },
});

function setup(answers: Array<string | ChatAnswer>) {
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
  const asked = () => handleMessage.mock.calls.map((c) => c[0] as string);
  return { say, replies, asked, executeCommand };
}

const OPTIONS = ['Crea nuova pratica', 'Controlla stato pratiche', 'Valida pratica'];

describe('answers to a question of the AI', () => {
  it('completes «crea nuova pratica» with the name given next (screenshot of 31/10)', async () => {
    const c = setup([question('Qual è il nome della pratica che desideri creare?')]);
    await c.say('Crea nuova pratica');
    await c.say('Scontrino 001');
    expect(c.asked()).toEqual(['Crea nuova pratica', 'Crea nuova pratica Scontrino 001']);
    expect(c.replies).toEqual(['Qual è il nome della pratica che desideri creare?', 'risposta AI']);
  });

  it('completes «valida pratica» with the practice given next', async () => {
    const c = setup([question('Quale pratica desideri validare?')]);
    await c.say('Valida pratica');
    await c.say('Scontrino 001');
    expect(c.asked()).toEqual(['Valida pratica', 'Valida pratica Scontrino 001']);
  });

  it('runs a completed request as a command when it becomes one', async () => {
    const c = setup([question('Come si chiama la pratica?')]);
    await c.say('crea pratica');
    await c.say('Scontrino 001');
    expect(c.executeCommand).toHaveBeenCalledWith(
      { type: 'CREATE_PRACTICE', payload: { name: 'Scontrino 001' } },
      expect.anything(),
      { channel: 'telegram' },
    );
    expect(c.asked()).toEqual(['crea pratica']);
  });

  it('takes an offered option as a new request, not as an answer', async () => {
    const c = setup([question('Cosa desideri fare con Scontrino 001?', OPTIONS)]);
    await c.say('Scontrino 001');
    await c.say('Valida pratica');
    expect(c.asked()).toEqual(['Scontrino 001', 'Valida pratica']);
  });

  it('leaves commands, long sentences and late answers alone', async () => {
    const c = setup([question('Quale pratica?'), question('Quale pratica?')]);
    await c.say('Valida pratica');
    await c.say('lista pratiche');
    expect(c.executeCommand).toHaveBeenCalledWith(
      { type: 'LIST_PRACTICES', payload: {} },
      expect.anything(),
      { channel: 'telegram' },
    );
    await c.say('Valida pratica');
    await c.say(
      'vorrei sapere invece quante pratiche ho creato questo mese in tutto, grazie mille',
    );
    expect(c.asked().at(-1)).toBe(
      'vorrei sapere invece quante pratiche ho creato questo mese in tutto, grazie mille',
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const late = setup([question('Quale pratica?')]);
      await late.say('Valida pratica');
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await late.say('Scontrino 001');
      expect(late.asked()).toEqual(['Valida pratica', 'Scontrino 001']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers only once: the next message is a new request', async () => {
    const c = setup([question('Quale pratica?')]);
    await c.say('Valida pratica');
    await c.say('Scontrino 001');
    await c.say('Prova');
    expect(c.asked()).toEqual(['Valida pratica', 'Valida pratica Scontrino 001', 'Prova']);
  });
});

describe('the AI adapter tells when it asked a question', () => {
  const adapter = (llmAnswer: object) =>
    new TelegramAdapter({
      interpreter: new InterpreterService({
        complete: () => Promise.resolve(JSON.stringify(llmAnswer)),
      }),
      normalizer: new NormalizerService(),
      decisionEngine: new DecisionEngine(),
      validateBeforeDecision,
      validateResolvedCommand,
      // A question back reaches no practice: the executor only passes it on.
      executor: {
        execute: (command) =>
          Promise.resolve({
            success: true,
            result: { type: 'clarification_required', ...(command.data as object) },
          }),
      },
      contextService: { getPracticeContext: () => Promise.resolve({ practices: [] }) },
      formatResponse: formatTelegramResponse,
    });
  const identity = { tenantId: 't-1', userId: 'u-1', role: 'ADMIN' as const };

  it('marks a clarification with its options', async () => {
    const answer = await adapter({
      schemaVersion: 1,
      action: 'clarification_required',
      confidence: 0.4,
      filters: { practiceId: null, status: null, name: null },
      artistName: null,
      nextState: null,
      clarification: {
        question: 'Qual è il nome della pratica che desideri creare?',
        reason: 'MISSING_NAME',
        options: ['Crea nuova pratica'],
        candidatePracticeIds: [],
      },
    }).answer('Crea nuova pratica', identity);
    expect(answer.text).toContain('Qual è il nome della pratica');
    expect(answer.clarification?.options).toEqual(['Crea nuova pratica']);
  });
});
