export type PracticeState = 'CREATED' | 'VALIDATED' | 'SUBMITTED' | 'FAILED' | 'COMPLETED';

export type TransitionInput = {
  tenantId: string;
  practiceId: string;
  nextState: PracticeState;
  userId: string | null;
};
