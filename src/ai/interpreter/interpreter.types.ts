import { z } from 'zod';

import type { PracticeContext } from '../context/context.service.js';

export const CURRENT_INTERPRETER_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

// Supported actions
export const InterpreterActionSchema = z.enum([
  'transition_practice',
  'create_practice',
  'clarification_required',
]);
export type InterpreterAction = z.infer<typeof InterpreterActionSchema>;

export const TransitionPracticeFiltersSchema = z.object({
  practiceId: z.string().uuid().nullable().default(null),
  status: z.string().min(1).nullable().default(null),
  name: z.string().min(1).nullable().default(null),
});

export const ClarificationDetailsSchema = z.object({
  question: z.string().min(1),
  reason: z.string().min(1),
  candidatePracticeIds: z.array(z.string()).default([]),
  options: z.array(z.string()).default([]),
});
export type ClarificationDetails = z.infer<typeof ClarificationDetailsSchema>;

export const InterpreterOutputSchema = z.object({
  schemaVersion: z.number().int().default(CURRENT_INTERPRETER_SCHEMA_VERSION),
  action: InterpreterActionSchema,
  confidence: z.number().min(0).max(1).default(1.0),
  filters: TransitionPracticeFiltersSchema.default({
    practiceId: null,
    status: null,
    name: null,
  }),
  artistName: z.string().min(1).nullable().default(null),
  nextState: z.string().min(1).nullable().default(null),
  clarification: ClarificationDetailsSchema.nullable().default(null),
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
