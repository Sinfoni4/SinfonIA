import { describe, expect, it } from 'vitest';

import { InterpreterService, InvalidAIOutputError, InterpreterError } from '../src/ai/index.js';

describe('ai interpreter', () => {
  it('returns structured JSON for valid input', async () => {
    const service = new InterpreterService({
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            action: 'transition_practice',
            filters: { practiceId: '550e8400-e29b-41d4-a716-446655440000' },
            nextState: 'VALIDATED',
          }),
        ),
    });

    const out = await service.interpret(
      'Per favore porta la pratica 550e8400-e29b-41d4-a716-446655440000 a VALIDATED',
    );

    expect(out.action).toBe('transition_practice');
    expect(out.nextState).toBe('VALIDATED');
  });

  it('applies null defaults for omitted filters and artistName', async () => {
    const service = new InterpreterService({
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            action: 'transition_practice',
            nextState: 'VALIDATED',
          }),
        ),
    });

    const out = await service.interpret('validate the practice');
    expect(out.filters).toEqual({ practiceId: null, status: null, name: null });
    expect(out.artistName).toBeNull();
  });

  it('throws InterpreterError for ambiguous input', async () => {
    const service = new InterpreterService({
      complete: () => Promise.resolve(JSON.stringify({ error: 'AMBIGUOUS_INPUT' })),
    });

    await expect(service.interpret('sistema la pratica')).rejects.toBeInstanceOf(InterpreterError);
  });

  it('throws InvalidAIOutputError for invalid model output', async () => {
    const service = new InterpreterService({
      complete: () => Promise.resolve('not-json-response'),
    });

    await expect(service.interpret('test')).rejects.toBeInstanceOf(InvalidAIOutputError);
  });

  it('parses JSON inside markdown code fence (fallback)', async () => {
    const service = new InterpreterService({
      complete: () =>
        Promise.resolve(
          '```json\n{"action":"transition_practice","filters":{"practiceId":"550e8400-e29b-41d4-a716-446655440000"},"nextState":"SUBMITTED"}\n```',
        ),
    });

    const out = await service.interpret('submit the practice');
    expect(out.action).toBe('transition_practice');
    expect(out.nextState).toBe('SUBMITTED');
  });
});
