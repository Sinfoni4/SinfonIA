import { describe, expect, it } from 'vitest';

import { ExecutorService } from '../src/ai/execution/executor.service.js';

import type { PracticeWorkflow } from '../src/core/workflow/practice.workflow.js';
import type { PracticeDTO } from '../src/data/types/domain.js';

describe('ai executor', () => {
  it('executes transition_practice with valid data', async () => {
    const workflow: Pick<PracticeWorkflow, 'transitionPractice'> = {
      transitionPractice: () =>
        Promise.resolve({
          id: '550e8400-e29b-41d4-a716-446655440000',
          tenantId: '11111111-1111-1111-1111-111111111111',
          userId: '22222222-2222-2222-2222-222222222222',
          status: 'VALIDATED',
          version: 1,
          payload: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies PracticeDTO),
    };
    const executor = new ExecutorService({
      practiceWorkflow: workflow as unknown as PracticeWorkflow,
    });

    const res = await executor.execute(
      {
        action: 'transition_practice',
        data: {
          practiceId: '550e8400-e29b-41d4-a716-446655440000',
          nextState: 'VALIDATED',
        },
      },
      {
        tenantId: '550e8400-e29b-41d4-a716-446655440001',
        userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      },
    );

    expect(res.success).toBe(true);
    if (res.success) {
      const result = res.result;
      if (typeof result !== 'object' || result === null || !('status' in result)) {
        throw new Error('Invalid executor result');
      }
      expect(result.status).toBe('VALIDATED');
    }
  });

  it('returns error for unsupported action', async () => {
    const workflow: Pick<PracticeWorkflow, 'transitionPractice'> = {
      transitionPractice: () =>
        Promise.resolve({
          id: '550e8400-e29b-41d4-a716-446655440000',
          tenantId: '11111111-1111-1111-1111-111111111111',
          userId: '22222222-2222-2222-2222-222222222222',
          status: 'CREATED',
          version: 1,
          payload: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies PracticeDTO),
    };
    const executor = new ExecutorService({
      practiceWorkflow: workflow as PracticeWorkflow,
    });

    const res = await executor.execute(
      { action: 'unknown_action', data: {} },
      { tenantId: '550e8400-e29b-41d4-a716-446655440001', userId: null },
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('UNSUPPORTED_ACTION');
    }
  });

  it('returns validation error for invalid data', async () => {
    const workflow: Pick<PracticeWorkflow, 'transitionPractice'> = {
      transitionPractice: () =>
        Promise.resolve({
          id: '550e8400-e29b-41d4-a716-446655440000',
          tenantId: '11111111-1111-1111-1111-111111111111',
          userId: '22222222-2222-2222-2222-222222222222',
          status: 'CREATED',
          version: 1,
          payload: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies PracticeDTO),
    };
    const executor = new ExecutorService({
      practiceWorkflow: workflow as PracticeWorkflow,
    });

    const res = await executor.execute(
      { action: 'transition_practice', data: { practiceId: 'not-a-uuid', nextState: 'NOPE' } },
      { tenantId: '550e8400-e29b-41d4-a716-446655440001', userId: null },
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
