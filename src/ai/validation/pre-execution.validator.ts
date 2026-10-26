import { z } from 'zod';

import { allowedNextStates, PRACTICE_STATES } from '../../core/workflow/state-machine.js';

import { ContextValidationError, PreExecutionValidationError } from './validation.errors.js';

import type { PracticeContext } from '../context/context.service.js';
import type { ExecutorInput } from '../execution/executor.types.js';
import type { InterpreterOutput } from '../interpreter/interpreter.types.js';

const StatusSchema = z.enum(PRACTICE_STATES);

function assertNonEmptyContext(practices: PracticeContext['practices']): void {
  if (!Array.isArray(practices) || practices.length === 0) {
    throw new ContextValidationError('Context practices array is empty');
  }
}

export function validateContextConsistency(practices: PracticeContext['practices']): void {
  assertNonEmptyContext(practices);

  const seen = new Set<string>();
  for (const p of practices) {
    if (!p || typeof p !== 'object') {
      throw new ContextValidationError('Context practice is invalid', {
        practice: p as unknown as Record<string, unknown>,
      });
    }
    if (typeof p.id !== 'string' || p.id.trim().length === 0) {
      throw new ContextValidationError('Context practice id is missing');
    }
    if (seen.has(p.id)) {
      throw new ContextValidationError('Context has duplicate practice IDs', { practiceId: p.id });
    }
    seen.add(p.id);

    const status = StatusSchema.safeParse(p.status);
    if (!status.success) {
      throw new ContextValidationError('Context practice status is invalid', {
        practiceId: p.id,
        status: p.status,
      });
    }
  }
}

/**
 * Enforce ID priority WITHOUT changing DecisionEngine logic:
 * if practiceId is present, remove other filters to prevent accidental over-filtering.
 */
export function enforceIdPriority(input: InterpreterOutput): InterpreterOutput {
  if (!input.filters.practiceId) return input;
  return {
    ...input,
    filters: {
      practiceId: input.filters.practiceId,
      status: null,
      name: null,
    },
  };
}

/**
 * Runs BEFORE DecisionEngine to turn "missing practiceId" into controlled validation error
 * instead of DecisionEngine "Ambiguous input".
 */
export function validateBeforeDecision(
  normalized: InterpreterOutput,
  practices: PracticeContext['practices'],
): void {
  validateContextConsistency(practices);

  if (normalized.action !== 'transition_practice') {
    throw new ContextValidationError('Unsupported action', { action: normalized.action });
  }

  if (normalized.filters.practiceId) {
    const found = practices.some((p) => p.id === normalized.filters.practiceId);
    if (!found) {
      throw new ContextValidationError('Practice not found in context', {
        practiceId: normalized.filters.practiceId,
      });
    }
  }
}

/**
 * Runs AFTER DecisionEngine (resolved command) and BEFORE Executor.
 * Guarantees that invalid transitions do not reach the executor.
 */
export function validateResolvedCommand(
  command: ExecutorInput,
  practices: PracticeContext['practices'],
): void {
  validateContextConsistency(practices);

  if (command.action !== 'transition_practice') {
    throw new PreExecutionValidationError('Unsupported resolved action', {
      action: command.action,
    });
  }

  const practiceId = command.data.practiceId;
  const nextState = command.data.nextState;
  if (typeof practiceId !== 'string' || practiceId.trim().length === 0) {
    throw new PreExecutionValidationError('Resolved command missing practiceId');
  }
  if (typeof nextState !== 'string' || nextState.trim().length === 0) {
    throw new PreExecutionValidationError('Resolved command missing nextState');
  }

  const nextParsed = StatusSchema.safeParse(nextState);
  if (!nextParsed.success) {
    throw new PreExecutionValidationError('Resolved command nextState is invalid', { nextState });
  }

  const practice = practices.find((p) => p.id === practiceId);
  if (!practice) {
    throw new PreExecutionValidationError('Resolved practiceId not found in context', {
      practiceId,
    });
  }

  const currentParsed = StatusSchema.safeParse(practice.status);
  if (!currentParsed.success) {
    throw new PreExecutionValidationError('Current practice status is invalid', {
      practiceId,
      status: practice.status,
    });
  }

  const currentStatus = currentParsed.data;
  const target = nextParsed.data;

  if (currentStatus === target) {
    throw new PreExecutionValidationError('Practice already in target state', {
      practiceId,
      status: currentStatus,
      nextState: target,
    });
  }

  const allowed = allowedNextStates(currentStatus);
  if (!allowed.includes(target)) {
    throw new PreExecutionValidationError('Transition not allowed', {
      practiceId,
      currentStatus,
      nextState: target,
      allowedNextStates: allowed,
    });
  }
}
