export type FlowName =
  'PRACTICE_STATUS' | 'PRACTICE_LIST' | 'NEXT_STEP_SUGGESTION' | 'AMBIGUITY_HANDLING';

export type FlowHandler = (input: string, userId: string) => Promise<string>;

export type FlowOrchestrator = (input: string, userId: string) => Promise<string | null>;
