import { describe, expect, it } from 'vitest';

import {
  allowedNextStates,
  canTransition,
  PRACTICE_STATES,
} from '../src/core/workflow/state-machine.js';

describe('practice state machine', () => {
  it('exposes every persisted state', () => {
    expect(PRACTICE_STATES).toEqual(['CREATED', 'VALIDATED', 'SUBMITTED', 'FAILED', 'COMPLETED']);
  });

  it('does not allow completing a practice directly from CREATED', () => {
    expect(canTransition('CREATED', 'COMPLETED')).toBe(false);
    expect(canTransition('CREATED', 'VALIDATED')).toBe(true);
  });

  it('allows completion only after validation or submission', () => {
    expect(allowedNextStates('VALIDATED')).toContain('COMPLETED');
    expect(allowedNextStates('SUBMITTED')).toContain('COMPLETED');
    expect(allowedNextStates('COMPLETED')).toEqual([]);
    expect(allowedNextStates('FAILED')).toEqual([]);
  });
});
