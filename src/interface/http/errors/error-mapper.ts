import { z } from 'zod';

import {
  ExecutorValidationError,
  ExecutionGuardError,
  UnsupportedActionError,
  WorkflowStateError,
} from '../../../ai/execution/executor.types.js';
import {
  InterpreterError,
  InvalidAIOutputError,
} from '../../../ai/interpreter/interpreter.types.js';
import { NormalizationValidationError } from '../../../ai/normalization/normalizer.service.js';
import { LLMDisabledError } from '../../../ai/providers/disabled.provider.js';
import { OpenAIProviderError } from '../../../ai/providers/openai.provider.js';
import { ValidationError } from '../../../ai/validation/validation.errors.js';
import { PermissionDeniedError } from '../../../core/authz/authorization.service.js';
import {
  AttachmentRejectedError,
  ComplianceValidationError,
  ConcurrencyError,
  InvalidStateTransitionError,
} from '../../../core/index.js';
import { NotFoundError, UnauthorizedTenantAccessError } from '../../../data/errors/errors.js';
import { AuthError } from '../auth/auth.errors.js';

export type NormalizedError = { statusCode: number; code: string; message: string };

export function mapErrorToHttp(err: unknown): NormalizedError {
  if (err instanceof AuthError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof PermissionDeniedError) {
    return { statusCode: 403, code: 'FORBIDDEN', message: 'Insufficient role for this operation' };
  }
  if (err instanceof ComplianceValidationError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof AttachmentRejectedError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof LLMDisabledError) {
    return { statusCode: 503, code: 'LLM_DISABLED', message: err.message };
  }
  if (err instanceof UnauthorizedTenantAccessError) {
    return { statusCode: 404, code: 'NOT_FOUND', message: 'Resource not found' };
  }
  if (err instanceof InvalidStateTransitionError) {
    return { statusCode: 400, code: 'INVALID_STATE_TRANSITION', message: err.message };
  }
  if (err instanceof ConcurrencyError) {
    return { statusCode: 409, code: 'CONCURRENCY_CONFLICT', message: err.message };
  }
  if (err instanceof NotFoundError) {
    return { statusCode: 404, code: 'NOT_FOUND', message: err.message };
  }
  if (err instanceof InterpreterError) {
    return { statusCode: 400, code: 'INTERPRETER_ERROR', message: err.message };
  }
  if (err instanceof InvalidAIOutputError) {
    return { statusCode: 422, code: 'INVALID_AI_OUTPUT', message: err.message };
  }
  if (err instanceof ExecutorValidationError) {
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: err.message };
  }
  if (err instanceof ValidationError) {
    return { statusCode: 400, code: err.code, message: err.message };
  }
  if (err instanceof NormalizationValidationError) {
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: err.message };
  }
  if (err instanceof UnsupportedActionError) {
    return { statusCode: 400, code: 'UNSUPPORTED_ACTION', message: err.message };
  }
  if (err instanceof WorkflowStateError) {
    return { statusCode: 409, code: 'EXECUTION_ERROR', message: err.message };
  }
  if (err instanceof ExecutionGuardError) {
    return { statusCode: 500, code: 'EXECUTION_ERROR', message: err.message };
  }
  if (err instanceof z.ZodError) {
    const msg = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: msg };
  }
  if (err instanceof OpenAIProviderError) {
    const code = err.statusCode === 429 ? 'RATE_LIMIT' : 'LLM_UNAVAILABLE';
    return { statusCode: err.statusCode ?? 502, code, message: err.message };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}
