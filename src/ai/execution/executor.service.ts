import { z } from 'zod';

import { can } from '../../core/authz/authorization.service.js';
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
import type { Permission } from '../../core/authz/permissions.js';
import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';

const TransitionPracticeDataSchema = z.object({
  practiceId: z.string().uuid(),
  nextState: z.enum(['CREATED', 'VALIDATED', 'SUBMITTED', 'FAILED', 'COMPLETED']),
});

const CreatePracticeDataSchema = z.object({
  artistName: z.string().min(1),
});

const ACTION_PERMISSIONS: Partial<Record<string, Permission>> = {
  create_practice: 'practice.create',
  transition_practice: 'practice.transition',
};

export class ExecutorService {
  constructor(
    private readonly deps: {
      practiceService: Pick<PracticeApplicationService, 'createPractice' | 'transitionPractice'>;
    },
  ) {}

  async execute(input: ExecutorInput, ctx: ExecutorContext): Promise<ExecutorResult<unknown>> {
    try {
      const parsedInput = ExecutorInputSchema.parse(input);
      const parsedCtx = ExecutorContextSchema.parse(ctx);

      // The AI only proposes: an action the requester may not perform is never executed.
      const permission = ACTION_PERMISSIONS[parsedInput.action];
      if (parsedCtx.role && permission && !can(parsedCtx.role, permission)) {
        return {
          success: false,
          error: { code: 'FORBIDDEN', message: `PERMISSION_DENIED: ${permission}` },
        };
      }

      switch (parsedInput.action) {
        case 'create_practice': {
          const data = CreatePracticeDataSchema.safeParse(parsedInput.data);
          if (!data.success) {
            throw new ExecutorValidationError('Invalid create_practice data');
          }
          if (!parsedCtx.userId) {
            throw new ExecutorValidationError('Authenticated user is required');
          }

          const created = await this.deps.practiceService.createPractice({
            tenantId: parsedCtx.tenantId,
            userId: parsedCtx.userId,
            name: data.data.artistName.trim(),
            kind: 'artist',
          });
          return { success: true, result: created };
        }
        case 'transition_practice': {
          const data = TransitionPracticeDataSchema.safeParse(parsedInput.data);
          if (!data.success) {
            throw new ExecutorValidationError('Invalid transition_practice data');
          }
          if (!parsedCtx.userId) {
            throw new ExecutorValidationError('Authenticated user is required');
          }

          const result = await this.deps.practiceService.transitionPractice({
            tenantId: parsedCtx.tenantId,
            userId: parsedCtx.userId,
            practiceId: data.data.practiceId,
            nextState: data.data.nextState,
          });

          return { success: true, result };
        }
        case 'clarification_required': {
          return {
            success: true,
            result: {
              type: 'clarification_required',
              ...parsedInput.data,
            },
          };
        }
        default:
          throw new UnsupportedActionError(parsedInput.action);
      }
    } catch (err: unknown) {
      return { success: false, error: toExecutorError(err) };
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
