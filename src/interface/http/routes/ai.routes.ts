import {
  enforceIdPriority,
  validateBeforeDecision,
  validateResolvedCommand,
} from '../../../ai/validation/pre-execution.validator.js';
import { AUTH_ROLES } from '../auth/auth.types.js';
import { requireRole } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import { validateAiInput } from '../validation/ai-input.validation.js';

import type { ContextService } from '../../../ai/context/context.service.js';
import type { DecisionEngine } from '../../../ai/decision/decision.engine.js';
import type { ExecutorService } from '../../../ai/execution/executor.service.js';
import type { InterpreterService } from '../../../ai/interpreter/interpreter.service.js';
import type { NormalizerService } from '../../../ai/normalization/normalizer.service.js';
import type { FastifyPluginCallback } from 'fastify';

export type AiRoutesDeps = {
  interpreterService: InterpreterService;
  executorService: ExecutorService;
  contextService: ContextService;
  decisionEngine: DecisionEngine;
  normalizerService: NormalizerService;
};

export const aiRoutes: FastifyPluginCallback<AiRoutesDeps> = (app, deps, done) => {
  app.post<{ Body: { input?: unknown } }>('/ai/execute', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.AI_EXECUTE);

      const body = req.body ?? {};
      const inputRaw =
        typeof body === 'object' && body !== null && 'input' in body ? body.input : undefined;
      const validation = validateAiInput(inputRaw);
      if (!validation.ok) {
        return reply.status(400).send(fail(validation.code, validation.message));
      }

      const practiceContext = await deps.contextService.getPracticeContext(
        auth.tenantId,
        auth.userId,
      );
      req.log.debug({ practiceCount: practiceContext.practices.length }, 'AI context loaded');
      const interpreted = await deps.interpreterService.interpret(validation.value, {
        tenantId: auth.tenantId,
        userId: auth.userId ?? null,
        practices: practiceContext.practices,
      });
      const normalized = enforceIdPriority(deps.normalizerService.normalize(interpreted));
      req.log.debug(
        { action: normalized.action, nextState: normalized.nextState },
        'AI command resolved',
      );

      if (normalized.action === 'create_practice') {
        const executorCtx = { tenantId: auth.tenantId, userId: auth.userId };
        const createCmd = {
          action: 'create_practice',
          data: { artistName: normalized.artistName },
        };
        const created = await deps.executorService.execute(createCmd, executorCtx);
        if (created.success) {
          return reply.status(200).send({ success: true, result: created.result });
        }
        return reply.status(200).send({ success: false, error: created.error });
      }

      // AI execution is open to every authenticated role, but state-changing
      // practice transitions remain restricted to ADMIN/OPERATOR.
      if (normalized.action === 'transition_practice') {
        requireRole(req, AUTH_ROLES.PRACTICE_TRANSITION);
      }

      validateBeforeDecision(normalized, practiceContext.practices);
      const resolved = deps.decisionEngine.resolveCommand(normalized, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        practices: practiceContext.practices,
      });

      validateResolvedCommand(resolved, practiceContext.practices);
      const executorCtx = {
        tenantId: auth.tenantId,
        userId: auth.userId,
      };
      const result = await deps.executorService.execute(resolved, executorCtx);

      if (result.success) {
        return reply.status(200).send({ success: true, result: result.result });
      }
      return reply.status(200).send({ success: false, error: result.error });
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });
  done();
};
