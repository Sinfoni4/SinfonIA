import type { PracticeState } from '../types/workflow.types.js';

export class InvalidStateTransitionError extends Error {
  readonly from: PracticeState;
  readonly to: PracticeState;

  constructor(from: PracticeState, to: PracticeState) {
    super(`Invalid practice state transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}
