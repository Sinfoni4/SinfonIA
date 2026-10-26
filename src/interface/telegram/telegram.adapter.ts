import { uuidFromSeed } from '../../core/tenant/tenant.uuid.js';

import { setPending } from './telegram.conversation.js';
import { getLastPractice, setLastPractice } from './telegram.memory.js';
import { checkPermission } from './telegram.permissions.js';
import { getUserRole } from './telegram.roles.js';

import type { PracticeContext } from '../../ai/context/context.service.js';
import type { ContextService } from '../../ai/context/context.service.js';
import type { DecisionEngine } from '../../ai/decision/decision.engine.js';
import type {
  ExecutorContext,
  ExecutorInput,
  ExecutorResult,
} from '../../ai/execution/executor.types.js';
import type { InterpreterService } from '../../ai/interpreter/interpreter.service.js';
import type {
  InterpreterContext,
  InterpreterOutput,
} from '../../ai/interpreter/interpreter.types.js';
import type { NormalizerService } from '../../ai/normalization/normalizer.service.js';
import type {
  validateBeforeDecision,
  validateResolvedCommand,
} from '../../ai/validation/pre-execution.validator.js';

export class TelegramAdapter {
  constructor(
    private readonly deps: {
      interpreter: Pick<InterpreterService, 'interpret'>;
      normalizer: Pick<NormalizerService, 'normalize'>;
      decisionEngine: Pick<DecisionEngine, 'resolveCommand'>;
      validateBeforeDecision: typeof validateBeforeDecision;
      validateResolvedCommand: typeof validateResolvedCommand;
      executor: {
        execute: (command: ExecutorInput, ctx: ExecutorContext) => Promise<ExecutorResult<unknown>>;
      };
      contextService: Pick<ContextService, 'getPracticeContext'>;
      formatResponse: (data: {
        input: string;
        command: ExecutorInput;
        result: ExecutorResult<unknown>;
      }) => string;
    },
  ) {}

  async handleMessage(input: string, userId: string): Promise<string> {
    // Telegram MVP: single-tenant demo.
    const tenantId = uuidFromSeed('demo-tenant');
    // Keep `userId` as the Telegram-specific memory key, but derive a UUID for DB/executor validation.
    const execUserId = uuidFromSeed(userId);
    const ctx: InterpreterContext = { tenantId, userId: execUserId, practices: [] };

    const lastId = getLastPractice(userId);
    if (lastId && /quella|precedente|prima/i.test(input)) {
      input = `${input} ${lastId}`;
    }

    const context: PracticeContext = await this.deps.contextService.getPracticeContext(
      tenantId,
      execUserId,
    );
    ctx.practices = context.practices;

    const interpreted: InterpreterOutput = await this.deps.interpreter.interpret(input, ctx);
    const normalized = this.deps.normalizer.normalize(interpreted);

    const role = getUserRole(userId);
    if (!checkPermission(role, normalized.action)) {
      // Optional UX: more specific message for associate when they try to advance state.
      if (role === 'ASSOCIATO' && normalized.action === 'transition_practice') {
        setPending(userId, {
          type: 'REQUEST_OPERATOR',
          payload: {
            action: normalized.action,
            practiceId: normalized.filters.practiceId,
          },
        });
        if (normalized.nextState === 'VALIDATED') {
          throw new Error('PERMISSION_DENIED:VALIDATED');
        }
        if (normalized.nextState === 'COMPLETED') {
          throw new Error('PERMISSION_DENIED:COMPLETED');
        }
      }
      throw new Error('PERMISSION_DENIED');
    }

    let command: ExecutorInput;
    if (normalized.action === 'create_practice') {
      command = { action: 'create_practice', data: { artistName: normalized.artistName } };
    } else {
      this.deps.validateBeforeDecision(normalized, context.practices);
      command = this.deps.decisionEngine.resolveCommand(normalized, {
        tenantId,
        userId,
        practices: context.practices,
      });
      this.deps.validateResolvedCommand(command, context.practices);
    }

    const execCtx: ExecutorContext = { tenantId, userId: execUserId };
    const result = await this.deps.executor.execute(command, execCtx);

    const maybeId =
      result &&
      typeof result === 'object' &&
      'success' in result &&
      (result as { success: boolean }).success
        ? (result as { success: true; result: unknown }).result
        : null;
    const id =
      maybeId &&
      typeof maybeId === 'object' &&
      maybeId !== null &&
      'id' in maybeId &&
      typeof maybeId.id === 'string'
        ? (maybeId as { id: string }).id
        : null;
    if (id) {
      setLastPractice(userId, id);
    }

    return this.deps.formatResponse({ input, command, result });
  }
}
