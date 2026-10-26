import { z } from 'zod';

import type { PracticeContext } from '../context/context.service.js';

// Supported actions (MVP). This can grow over time.
export const InterpreterActionSchema = z.enum(['transition_practice', 'create_practice']);
export type InterpreterAction = z.infer<typeof InterpreterActionSchema>;

export const TransitionPracticeFiltersSchema = z.object({
  practiceId: z.string().uuid().nullable().default(null),
  status: z.string().min(1).nullable().default(null),
  name: z.string().min(1).nullable().default(null),
});

export const InterpreterOutputSchema = z.object({
  action: InterpreterActionSchema,
  filters: TransitionPracticeFiltersSchema.default({
    practiceId: null,
    status: null,
    name: null,
  }),
  artistName: z.string().min(1).nullable().default(null),
  nextState: z.string().min(1),
});

export type InterpreterOutput = z.infer<typeof InterpreterOutputSchema>;

export type InterpreterContext = {
  tenantId: string;
  userId?: string | null;
  practices?: PracticeContext['practices'];
};

export class InterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterError';
  }
}

export class InvalidAIOutputError extends InterpreterError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAIOutputError';
  }
}
