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
import { AssistanceError } from '../../../core/assistance/assistance.service.js';
import { PermissionDeniedError } from '../../../core/authz/authorization.service.js';
import { CustomRoleError } from '../../../core/authz/custom-roles.service.js';
import { PlatformAccessError } from '../../../core/authz/platform.js';
import { DelegationError } from '../../../core/delegation/delegation.service.js';
import { FeatureDisabledError } from '../../../core/features/features.js';
import { InvitationError, LoginError } from '../../../core/identity/login.service.js';
import { MemberAccessError } from '../../../core/identity/member-access.service.js';
import { LastAdminError } from '../../../core/identity/revocation.service.js';
import {
  AttachmentRejectedError,
  ComplianceValidationError,
  ConcurrencyError,
  DuplicateAttachmentError,
  InvalidStateTransitionError,
} from '../../../core/index.js';
import { NetworkError } from '../../../core/network/network.service.js';
import { CompanyIdentifiersError } from '../../../core/organization/company-identifiers.js';
import { OrganizationSettingsError } from '../../../core/organization/organization-settings.service.js';
import { PlatformActionError } from '../../../core/platform/platform.service.js';
import { AttachmentValidationError } from '../../../core/practice/attachment-validation.js';
import { AssignmentError } from '../../../core/practice/practice-assignment.js';
import { PracticeModuleError } from '../../../core/practice/practice-module.js';
import { NotFoundError, UnauthorizedTenantAccessError } from '../../../data/errors/errors.js';
import { AuthError } from '../auth/auth.errors.js';

export type NormalizedError = { statusCode: number; code: string; message: string };

export function mapErrorToHttp(err: unknown): NormalizedError {
  if (err instanceof AuthError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof FeatureDisabledError) {
    return {
      statusCode: 403,
      code: 'FEATURE_DISABLED',
      message: "Questa funzione non è attiva per l'organizzazione",
    };
  }
  if (err instanceof PermissionDeniedError) {
    return { statusCode: 403, code: 'FORBIDDEN', message: 'Insufficient role for this operation' };
  }
  if (
    err instanceof LastAdminError ||
    err instanceof CustomRoleError ||
    err instanceof MemberAccessError ||
    err instanceof LoginError ||
    err instanceof InvitationError ||
    err instanceof OrganizationSettingsError ||
    err instanceof CompanyIdentifiersError ||
    err instanceof PlatformAccessError ||
    err instanceof PlatformActionError ||
    err instanceof AttachmentValidationError ||
    err instanceof AssistanceError ||
    err instanceof AssignmentError ||
    err instanceof PracticeModuleError ||
    err instanceof NetworkError ||
    err instanceof DelegationError
  ) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof ComplianceValidationError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  if (err instanceof AttachmentRejectedError || err instanceof DuplicateAttachmentError) {
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
