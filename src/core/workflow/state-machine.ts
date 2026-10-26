import type { PracticeState } from '../types/workflow.types.js';

/**
 * Single source of truth for the practice lifecycle.
 *
 * Policy: an operator cannot complete a practice that was never validated.
 * `CREATED -> SUBMITTED` remains available for integrations that submit
 * without an explicit validation step.
 */
export const PRACTICE_STATES = [
  'CREATED',
  'VALIDATED',
  'SUBMITTED',
  'FAILED',
  'COMPLETED',
] as const satisfies readonly PracticeState[];

export const ALLOWED_TRANSITIONS: Readonly<Record<PracticeState, ReadonlyArray<PracticeState>>> = {
  CREATED: ['VALIDATED', 'SUBMITTED'],
  VALIDATED: ['SUBMITTED', 'COMPLETED'],
  SUBMITTED: ['COMPLETED', 'FAILED'],
  FAILED: [],
  COMPLETED: [],
};

export function canTransition(from: PracticeState, to: PracticeState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedNextStates(from: PracticeState): ReadonlyArray<PracticeState> {
  return ALLOWED_TRANSITIONS[from];
}
