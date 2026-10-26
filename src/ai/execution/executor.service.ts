import { z } from 'zod';

import { InvalidStateTransitionError } from '../../core/errors/workflow.errors.js';
import { NotFoundError } from '../../data/errors/errors.js';

import {
  ExecutorContextSchema,
  ExecutorError,
  ExecutorInputSchema,
  ExecutorValidationError,
  ExecutionGuardError,
  UnsupportedActionError,
  WorkflowStateError,
} from './executor.types.js';

import type { ExecutorContext, ExecutorInput, ExecutorResult } from './executor.types.js';
import type { PracticeWorkflow } from '../../core/workflow/practice.workflow.js';
import type { InMemoryPracticeRepository } from '../../domain/practice.repository.js';

const TransitionPracticeDataSchema = z.object({
  practiceId: z.string().uuid(),
  nextState: z.enum(['CREATED', 'VALIDATED', 'SUBMITTED', 'FAILED', 'COMPLETED']),
});

const CreatePracticeDataSchema = z.object({
  artistName: z.string().min(1),
});

export class ExecutorService {
  constructor(
    private readonly deps: {
      practiceWorkflow: PracticeWorkflow;
      artistPracticeRepo?: InMemoryPracticeRepository;
    },
  ) {}

  async execute(input: ExecutorInput, ctx: ExecutorContext): Promise<ExecutorResult<unknown>> {
    try {
      const parsedInput = ExecutorInputSchema.parse(input);
      const parsedCtx = ExecutorContextSchema.parse(ctx);

      switch (parsedInput.action) {
        case 'create_practice': {
          const data = CreatePracticeDataSchema.safeParse(parsedInput.data);
          if (!data.success) {
            throw new ExecutorValidationError('Invalid create_practice data');
          }
          if (!this.deps.artistPracticeRepo) {
            throw new ExecutorValidationError('Artist practice repository not configured');
          }
          const created = this.deps.artistPracticeRepo.create(data.data.artistName.trim());
          const output: ExecutorResult<unknown> = { success: true, result: created };
          console.log('[ai-flow]', { step: 'executor', input: parsedInput, output });
          return output;
        }
        case 'transition_practice': {
          const data = TransitionPracticeDataSchema.safeParse(parsedInput.data);
          if (!data.success) {
            throw new ExecutorValidationError('Invalid transition_practice data');
          }

          const artist = this.deps.artistPracticeRepo?.findById(data.data.practiceId) ?? null;
          if (artist) {
            if (data.data.nextState !== 'VALIDATED' && data.data.nextState !== 'COMPLETED') {
              throw new ExecutorValidationError(
                `Invalid artist practice nextState: ${data.data.nextState}`,
              );
            }
            try {
              const updated = this.deps.artistPracticeRepo!.updateStatus(
                data.data.practiceId,
                data.data.nextState,
              );
              const output: ExecutorResult<unknown> = { success: true, result: updated };
              console.log('[ai-flow]', { step: 'executor', input: parsedInput, output });
              return output;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new ExecutorValidationError(msg);
            }
          }

          const result = await this.deps.practiceWorkflow.transitionPractice({
            tenantId: parsedCtx.tenantId,
            userId: parsedCtx.userId,
            practiceId: data.data.practiceId,
            nextState: data.data.nextState,
          });

          const output: ExecutorResult<unknown> = { success: true, result };
          console.log('[ai-flow]', { step: 'executor', input: parsedInput, output });
          return output;
        }
        default:
          throw new UnsupportedActionError(parsedInput.action);
      }
    } catch (err: unknown) {
      const output: ExecutorResult<unknown> = { success: false, error: toExecutorError(err) };
      console.log('[ai-flow]', { step: 'executor', input, output });
      return output;
    }
  }
}

function toExecutorError(err: unknown): { code: string; message: string } {
  if (err instanceof z.ZodError) {
    return { code: 'VALIDATION_ERROR', message: 'Invalid executor input' };
  }
  if (err instanceof UnsupportedActionError) {
    return { code: 'UNSUPPORTED_ACTION', message: err.message };
  }
  if (err instanceof ExecutorValidationError) {
    return { code: 'VALIDATION_ERROR', message: err.message };
  }
  if (err instanceof InvalidStateTransitionError) {
    return { code: 'VALIDATION_ERROR', message: err.message };
  }
  if (err instanceof NotFoundError) {
    return { code: 'VALIDATION_ERROR', message: err.message };
  }
  if (err instanceof WorkflowStateError) {
    return { code: 'EXECUTION_ERROR', message: err.message };
  }
  if (err instanceof ExecutionGuardError) {
    return { code: 'EXECUTION_ERROR', message: err.message };
  }
  if (err instanceof ExecutorError) {
    return { code: 'EXECUTION_ERROR', message: err.message };
  }

  const msg = err instanceof Error ? err.message : 'Unknown error';
  return {
    code: 'INTERNAL_ERROR',
    message: new ExecutionGuardError(`Internal executor error: ${msg}`).message,
  };
}
