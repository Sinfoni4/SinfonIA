import { z } from 'zod';

// Generic input coming from the Interpreter output contract.
export const ExecutorInputSchema = z.object({
  action: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

export type ExecutorInput = z.infer<typeof ExecutorInputSchema>;

// Execution context is deterministic and MUST NOT come from the LLM.
export const ExecutorContextSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
});

export type ExecutorContext = z.infer<typeof ExecutorContextSchema>;

export type ExecutorSuccess<T> = { success: true; result: T };
export type ExecutorFailure = { success: false; error: { code: string; message: string } };
export type ExecutorResult<T> = ExecutorSuccess<T> | ExecutorFailure;

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export class ExecutorValidationError extends ExecutorError {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorValidationError';
  }
}

/** Defensive wrapper for unexpected runtime failures inside ExecutorService. */
export class ExecutionGuardError extends ExecutorError {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionGuardError';
  }
}

/** Semantic workflow/state related execution error (should be prevented by pre-exec validator). */
export class WorkflowStateError extends ExecutorError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowStateError';
  }
}

export class UnsupportedActionError extends ExecutorError {
  constructor(action: string) {
    super(`Unsupported action: ${action}`);
    this.name = 'UnsupportedActionError';
  }
}
