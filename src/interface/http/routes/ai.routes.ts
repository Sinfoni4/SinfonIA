import {
  enforceIdPriority,
  validateBeforeDecision,
  validateResolvedCommand,
} from '../../../ai/validation/pre-execution.validator.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import { getRequestContext } from '../middleware/request-context.js';
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
      const ctx = getRequestContext(req);
      if (!ctx) {
        return reply.status(500).send(fail('INTERNAL_ERROR', 'Request context not available'));
      }
      if (!ctx.tenantId) {
        return reply.status(400).send(fail('MISSING_TENANT', 'Missing x-tenant-id header'));
      }

      const body = req.body ?? {};
      const inputRaw =
        typeof body === 'object' && body !== null && 'input' in body ? body.input : undefined;
      const validation = validateAiInput(inputRaw);
      if (!validation.ok) {
        return reply.status(400).send(fail(validation.code, validation.message));
      }

      const practiceContext = await deps.contextService.getPracticeContext(
        ctx.tenantId,
        ctx.userId ?? null,
      );
      console.log('[ai-flow]', {
        step: 'context',
        input: validation.value,
        output: practiceContext,
      });
      const interpreted = await deps.interpreterService.interpret(validation.value, {
        tenantId: ctx.tenantId,
        userId: ctx.userId ?? null,
        practices: practiceContext.practices,
      });
      console.log('[ai-flow]', { step: 'interpret', input: validation.value, output: interpreted });
      const normalized = enforceIdPriority(deps.normalizerService.normalize(interpreted));
      console.log('[ai-flow]', { step: 'normalize', input: interpreted, output: normalized });

      if (normalized.action === 'create_practice') {
        const executorCtx = { tenantId: ctx.tenantId, userId: ctx.userId ?? null };
        const createCmd = {
          action: 'create_practice',
          data: { artistName: normalized.artistName },
        };
        console.log('[ai-flow]', { step: 'decision', input: normalized, output: createCmd });
        const created = await deps.executorService.execute(createCmd, executorCtx);
        console.log('[ai-flow]', { step: 'execute', input: createCmd, output: created });
        if (created.success) {
          return reply.status(200).send({ success: true, result: created.result });
        }
        return reply.status(200).send({ success: false, error: created.error });
      }

      validateBeforeDecision(normalized, practiceContext.practices);
      const resolved = deps.decisionEngine.resolveCommand(normalized, {
        tenantId: ctx.tenantId,
        userId: ctx.userId ?? null,
        practices: practiceContext.practices,
      });
      console.log('[ai-flow]', { step: 'decision', input: normalized, output: resolved });

      validateResolvedCommand(resolved, practiceContext.practices);
      const executorCtx = {
        tenantId: ctx.tenantId,
        userId: ctx.userId ?? null,
      };
      const result = await deps.executorService.execute(resolved, executorCtx);
      console.log('[ai-flow]', { step: 'execute', input: resolved, output: result });

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
