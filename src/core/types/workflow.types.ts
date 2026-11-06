import type { PracticeKind } from '../practice/practice.payload.js';

export type PracticeState = 'CREATED' | 'VALIDATED' | 'SUBMITTED' | 'FAILED' | 'COMPLETED';

export type TransitionInput = {
  tenantId: string;
  practiceId: string;
  nextState: PracticeState;
  userId: string | null;
};

export type CreatePracticeInput = {
  tenantId: string;
  userId: string;
  name: string;
  kind?: PracticeKind;
  metadata?: Record<string, unknown>;
  /** AGX-03: the person the practice is opened for; checked against the organization. */
  holderUserId?: string | null;
};
