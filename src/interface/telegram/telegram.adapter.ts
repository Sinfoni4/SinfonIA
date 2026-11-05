import { randomUUID } from 'node:crypto';

import { LLMDisabledError } from '../../ai/providers/disabled.provider.js';
import { enforceIdPriority } from '../../ai/validation/pre-execution.validator.js';
import { can } from '../../core/authz/authorization.service.js';
import {
  InMemoryConversationMemory,
  type ConversationMemory,
} from '../conversation/conversation.memory.js';

import { FINAL_STATES, TRANSITION_VERBS } from './practice.command.formatter.js';

import type { TelegramIdentity } from './telegram.bot.js';
import type { PracticeContext } from '../../ai/context/context.service.js';
import type { ContextService } from '../../ai/context/context.service.js';
import type { DecisionEngine } from '../../ai/decision/decision.engine.js';
import type {
  ExecutorContext,
  ExecutorInput,
  ExecutorResult,
} from '../../ai/execution/executor.types.js';
import type { InterpreterService } from '../../ai/interpreter/interpreter.service.js';
import type { InterpreterDetailsResult } from '../../ai/interpreter/interpreter.service.js';
import type {
  InterpreterContext,
  InterpreterOutput,
} from '../../ai/interpreter/interpreter.types.js';
import type { NormalizerService } from '../../ai/normalization/normalizer.service.js';
import type { AITraceOutcome, AITracer } from '../../ai/tracing/ai.tracer.js';
import type {
  validateBeforeDecision,
  validateResolvedCommand,
} from '../../ai/validation/pre-execution.validator.js';
import type { PracticeState } from '../../core/types/workflow.types.js';
import type { ChatAnswer } from '../conversation/conversation.service.js';

/** What a chat answer records about its call to the AI (S08). */
type ChatTrace = {
  meta: InterpreterDetailsResult['traceMeta'] | null;
  action: string | null;
  outcome: AITraceOutcome;
};

export class TelegramAdapter {
  constructor(
    private readonly deps: {
      interpreter: Pick<InterpreterService, 'interpret'> &
        Partial<Pick<InterpreterService, 'interpretWithDetails'>>;
      /**
       * S08: the AI calls from the chat are traced like those of the API (provider, model, tokens,
       * time, outcome; never the text), for the console and the measure of consumption.
       */
      tracer?: Pick<AITracer, 'record'>;
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
      /** Defaults to process memory; production passes the database one. */
      memory?: ConversationMemory;
    },
  ) {
    this.memory = deps.memory ?? new InMemoryConversationMemory();
  }

  private readonly memory: ConversationMemory;

  async handleMessage(input: string, identity: TelegramIdentity): Promise<string> {
    return (await this.answer(input, identity)).text;
  }

  /** The reply, saying when it is a question back (the conversation then awaits the answer). */
  async answer(input: string, identity: TelegramIdentity): Promise<ChatAnswer> {
    const tracer = this.deps.tracer;
    if (!tracer) return this.answerAndTrace(input, identity, null);
    const trace: ChatTrace = { meta: null, action: null, outcome: 'ERROR' };
    const started = performance.now();
    try {
      const answer = await this.answerAndTrace(input, identity, trace);
      trace.outcome = answer.clarification ? 'AMBIGUOUS' : 'SUCCESS';
      return answer;
    } catch (err: unknown) {
      trace.outcome = err instanceof LLMDisabledError ? 'LLM_DISABLED' : 'ERROR';
      throw err;
    } finally {
      // Only when the AI was actually asked: a reply without a call to the provider is not a use.
      if (trace.meta) {
        tracer.record({
          requestId: `chat_${randomUUID()}`,
          tenantId: identity.tenantId,
          userId: identity.userId,
          model: trace.meta.model,
          provider: trace.meta.provider,
          ...(trace.meta.tokens ? { tokens: trace.meta.tokens } : {}),
          latencyMs: Math.round(performance.now() - started),
          outcome: trace.outcome,
          action: trace.action,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private async answerAndTrace(
    input: string,
    identity: TelegramIdentity,
    trace: ChatTrace | null,
  ): Promise<ChatAnswer> {
    const { tenantId, userId: execUserId, role } = identity;
    const ctx: InterpreterContext = { tenantId, userId: execUserId, practices: [] };

    const memory = this.memory;
    const lastId = await memory.getLastPractice(execUserId);
    if (lastId && /quella|precedente|prima/i.test(input)) {
      input = `${input} ${lastId}`;
    }

    const context: PracticeContext = await this.deps.contextService.getPracticeContext(
      tenantId,
      execUserId,
    );
    ctx.practices = context.practices;

    let interpreted: InterpreterOutput;
    if (trace && this.deps.interpreter.interpretWithDetails) {
      const details = await this.deps.interpreter.interpretWithDetails(input, ctx);
      trace.meta = details.traceMeta;
      interpreted = details.output;
    } else {
      interpreted = await this.deps.interpreter.interpret(input, ctx);
    }
    const normalized = enforceIdPriority(this.deps.normalizer.normalize(interpreted));
    if (trace) trace.action = normalized.action;

    const canAdvance = can(role, 'practice.transition');
    if (normalized.action === 'transition_practice' && !canAdvance) {
      if (normalized.nextState === 'VALIDATED') {
        throw new Error('PERMISSION_DENIED:VALIDATED');
      }
      if (normalized.nextState === 'COMPLETED') {
        throw new Error('PERMISSION_DENIED:COMPLETED');
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
        userId: execUserId,
        practices: context.practices,
      });
      this.deps.validateResolvedCommand(command, context.practices);
    }

    // S02: the AI never changes the state of a practice by itself: it proposes the change and
    // the person confirms it (the confirmation runs the normal command, with every check).
    if (command.action === 'transition_practice') {
      const data = command.data as { practiceId?: unknown; nextState?: unknown };
      const practice = context.practices.find((p) => p.id === data.practiceId);
      const nextState = data.nextState as PracticeState;
      if (practice && typeof data.practiceId === 'string' && nextState in TRANSITION_VERBS) {
        return {
          text:
            `❓ Vuoi ${TRANSITION_VERBS[nextState]} la pratica «${practice.name}»?` +
            (FINAL_STATES.has(nextState) ? ' Dopo non si potrà più cambiare stato.' : '') +
            ' Rispondi «sì» per confermare.',
          confirmTransition: { practiceId: data.practiceId, nextState },
        };
      }
    }

    const execCtx: ExecutorContext = { tenantId, userId: execUserId, role };
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
      await memory.setLastPractice(tenantId, execUserId, id);
    }

    const text = this.deps.formatResponse({ input, command, result });
    const clarification = clarificationOf(command, result);
    return clarification ? { text, clarification } : { text };
  }
}

/** The options of a question back of the AI, or null when the AI acted. */
function clarificationOf(
  command: ExecutorInput,
  result: ExecutorResult<unknown>,
): { options: string[] } | null {
  const payload =
    result && typeof result === 'object' && 'success' in result && result.success
      ? (result as { success: true; result: unknown }).result
      : null;
  const asked =
    command.action === 'clarification_required' ||
    (typeof payload === 'object' &&
      payload !== null &&
      (payload as { type?: unknown }).type === 'clarification_required');
  if (!asked) return null;
  const options = (payload as { options?: unknown } | null)?.options;
  return {
    options: Array.isArray(options)
      ? options.filter((o): o is string => typeof o === 'string')
      : [],
  };
}
