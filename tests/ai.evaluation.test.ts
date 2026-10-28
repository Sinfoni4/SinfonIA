import { describe, expect, it, vi } from 'vitest';

import { EvaluationHarness } from '../src/ai/evaluation/evaluation.harness.js';
import { GOLDEN_SET } from '../src/ai/evaluation/golden-set.js';

import type { GoldenScenario } from '../src/ai/evaluation/evaluation.types.js';
import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

const ROSSI = '550e8400-e29b-41d4-a716-446655440000';

function answer(fields: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    confidence: 0.95,
    filters: { practiceId: null, status: null, name: null },
    artistName: null,
    nextState: null,
    clarification: null,
    ...fields,
  });
}
const ask = answer({
  action: 'clarification_required',
  confidence: 0.3,
  clarification: { question: 'Cosa intendi?', reason: 'X', candidatePracticeIds: [], options: [] },
});

/** A "real" provider: called through completeDetailed, with token usage, like OpenAI. */
function fakeModel(reply: (prompt: string) => string): LLMClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    model: 'fake-model',
    complete: vi.fn((prompt: string) => Promise.resolve(reply(prompt))),
    completeDetailed: vi.fn((prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve({
        text: reply(prompt),
        model: 'fake-model',
        provider: 'fake',
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      });
    }),
  };
}

const validate: GoldenScenario = {
  id: 't-validate',
  type: 'VALID_COMMAND',
  input: `valida la pratica ${ROSSI}`,
  description: '',
  expectedAction: 'transition_practice',
  expectedPracticeId: ROSSI,
  expectedNextState: 'VALIDATED',
};

describe('AI evaluation harness', () => {
  it('has a golden set of at least 60 scenarios that passes in pipeline mode', async () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(60);
    const { metrics } = await new EvaluationHarness().runEvaluation();
    expect(metrics.mode).toBe('pipeline');
    expect(metrics.failures).toEqual([]);
    expect(metrics.gatePassed).toBe(true);
  });

  it('checks the target practice and state, not only the action type', async () => {
    const wrongState = fakeModel(() =>
      answer({
        action: 'transition_practice',
        filters: { practiceId: ROSSI, status: null, name: null },
        nextState: 'COMPLETED',
      }),
    );
    const { results, metrics } = await new EvaluationHarness({
      scenarios: [validate],
      llmClient: wrongState,
    }).runEvaluation();
    expect(results[0]?.isWrongExecution).toBe(true);
    expect(results[0]?.detail).toContain('expected state VALIDATED, got COMPLETED');
    expect(metrics.gatePassed).toBe(false);
  });

  it('tolerates a safe miss of the real model within the success threshold', async () => {
    const scenarios = Array.from({ length: 20 }, (_, i) => ({ ...validate, id: `t-${i}` }));
    let call = 0;
    const model = fakeModel(() =>
      ++call === 1
        ? ask
        : answer({
            action: 'transition_practice',
            filters: { practiceId: ROSSI, status: null, name: null },
            nextState: 'VALIDATED',
          }),
    );
    const { metrics } = await new EvaluationHarness({
      scenarios,
      llmClient: model,
    }).runEvaluation();
    expect(metrics.mode).toBe('model');
    expect(metrics.successRate).toBe(0.95);
    expect(metrics.misses).toHaveLength(1);
    expect(metrics.gatePassed).toBe(true);
  });

  it('detects personal data in prompts sent through completeDetailed', async () => {
    const model = fakeModel(() => answer({ action: 'create_practice', artistName: 'x' }));
    const scenario: GoldenScenario = {
      id: 't-leak',
      type: 'PII_INPUT',
      // A customer code no masker recognizes: it reaches the provider in clear.
      input: 'crea pratica per Anna, codice cliente zz-998877',
      description: '',
      expectedAction: 'create_practice',
      containsPII: true,
      sensitiveValues: ['zz-998877'],
    };
    const { results, metrics } = await new EvaluationHarness({
      scenarios: [scenario],
      llmClient: model,
    }).runEvaluation();
    expect(model.prompts).toHaveLength(1);
    expect(results[0]?.hasPiiLeaked).toBe(true);
    expect(metrics.gatePassed).toBe(false);
  });

  it('stops when the cost budget is exhausted', async () => {
    const scenarios = Array.from({ length: 5 }, (_, i) => ({ ...validate, id: `b-${i}` }));
    const model = fakeModel(() =>
      answer({
        action: 'transition_practice',
        filters: { practiceId: ROSSI, status: null, name: null },
        nextState: 'VALIDATED',
      }),
    );
    // Each call costs about $0.00021 with the fake usage: the budget allows two.
    const { metrics } = await new EvaluationHarness({
      scenarios,
      llmClient: model,
      maxCostUsd: 0.0003,
    }).runEvaluation();
    expect(metrics.executedScenarios).toBe(2);
    expect(metrics.gatePassed).toBe(false);
    expect(metrics.failures[0]).toContain('Cost budget');
  });
});
