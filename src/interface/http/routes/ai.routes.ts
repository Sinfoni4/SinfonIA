import { performance } from 'node:perf_hooks';

import { z } from 'zod';

import {
  AI_TRACE_OUTCOMES,
  defaultAITracer,
  type AITracer,
  type AITraceRecord,
} from '../../../ai/tracing/ai.tracer.js';
import {
  enforceIdPriority,
  validateBeforeDecision,
  validateResolvedCommand,
} from '../../../ai/validation/pre-execution.validator.js';
import { authorize } from '../../../core/authz/authorization.service.js';
import { parsePracticeCommand } from '../../../core/practice/practice.commands.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import { getRequestContext } from '../middleware/request-context.js';
import { validateAiInput } from '../validation/ai-input.validation.js';

import type { ContextService } from '../../../ai/context/context.service.js';
import type { DecisionEngine } from '../../../ai/decision/decision.engine.js';
import type { ExecutorService } from '../../../ai/execution/executor.service.js';
import type { InterpreterService } from '../../../ai/interpreter/interpreter.service.js';
import type { NormalizerService } from '../../../ai/normalization/normalizer.service.js';
import type { PracticeApplicationService } from '../../../core/practice/practice.application.service.js';
import type { FastifyPluginCallback } from 'fastify';

export type AiRoutesDeps = {
  practiceService?: PracticeApplicationService;
  interpreterService: InterpreterService;
  executorService: ExecutorService;
  contextService: ContextService;
  decisionEngine: DecisionEngine;
  normalizerService: NormalizerService;
  tracer?: AITracer;
};

const AiTracesQuerySchema = z
  .object({
    outcome: z.enum(AI_TRACE_OUTCOMES).optional(),
    // ISO dates or date-times, e.g. 2026-10-01 or 2026-10-01T08:00:00Z.
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });

export const aiRoutes: FastifyPluginCallback<AiRoutesDeps> = (app, deps, done) => {
  const tracer = deps.tracer ?? defaultAITracer;

  // Traces of the caller's tenant, most recent first, filterable by outcome and time range.
  app.get('/ai/traces', { config: { permission: 'ai.traces.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'ai.traces.read').principal;
      const query = AiTracesQuerySchema.parse(req.query);
      const { items, total } = await tracer.queryTraces({
        tenantId: auth.tenantId,
        outcome: query.outcome,
        from: query.from,
        to: query.to,
        page: query.page,
        limit: query.limit,
      });
      return reply.status(200).send({
        success: true,
        data: items,
        meta: {
          total,
          page: query.page,
          limit: query.limit,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.post<{ Body: { input?: unknown } }>(
    '/ai/execute',
    { config: { permission: 'ai.execute' } },
    async (req, reply) => {
      const startTime = performance.now();
      const reqCtx = getRequestContext(req);
      const requestId = reqCtx?.requestId ?? req.id;

      let tenantId = '';
      let userId: string | null = null;

      try {
        const auth = requirePermission(req, 'ai.execute').principal;
        tenantId = auth.tenantId;
        userId = auth.userId;

        const body = req.body ?? {};
        const inputRaw =
          typeof body === 'object' && body !== null && 'input' in body ? body.input : undefined;
        const validation = validateAiInput(inputRaw);
        if (!validation.ok) {
          return reply.status(400).send(fail(validation.code, validation.message));
        }

        // Check if LLM is enabled
        if (!deps.interpreterService.isLLMEnabled()) {
          const detCommand = parsePracticeCommand(validation.value);

          if (detCommand && deps.practiceService) {
            const detResult = await deps.practiceService.executeCommand(detCommand, auth, {
              channel: 'api',
            });

            const latencyMs = Math.round(performance.now() - startTime);
            const trace: AITraceRecord = {
              requestId,
              tenantId: auth.tenantId,
              userId: auth.userId,
              model: 'deterministic-engine',
              provider: 'core',
              latencyMs,
              outcome: 'DETERMINISTIC_FALLBACK',
              action: detCommand.type,
              timestamp: new Date().toISOString(),
            };
            tracer.record(trace);
            req.log.info({ aiTrace: trace }, 'AI deterministic fallback executed');

            return reply.status(200).send({
              success: true,
              mode: 'deterministic',
              result: detResult,
              meta: { trace },
            });
          }

          const latencyMs = Math.round(performance.now() - startTime);
          const trace: AITraceRecord = {
            requestId,
            tenantId: auth.tenantId,
            userId: auth.userId,
            model: 'none',
            provider: 'disabled',
            latencyMs,
            outcome: 'LLM_DISABLED',
            error: 'LLM_DISABLED',
            timestamp: new Date().toISOString(),
          };
          tracer.record(trace);
          req.log.warn({ aiTrace: trace }, 'AI execution rejected: LLM disabled');

          return reply.status(503).send({
            success: false,
            error: {
              code: 'LLM_DISABLED',
              message:
                'Il motore AI/LLM è disabilitato. Sono supportati solo i comandi deterministici: "crea pratica <nome>", "stato pratica <nome>", "export pratiche [oggi|mese|anno]".',
              availableCommands: [
                'crea pratica <nome>',
                'stato pratica <nome>',
                'export pratiche [oggi|mese|anno]',
              ],
            },
            meta: { trace },
          });
        }

        // Context retrieval tenant-scoped with keyword/relevance detection
        const practiceContext =
          typeof deps.contextService.getRelevantPracticeContext === 'function'
            ? await deps.contextService.getRelevantPracticeContext(
                auth.tenantId,
                validation.value,
                auth.userId,
              )
            : await deps.contextService.getPracticeContext(auth.tenantId, auth.userId);

        req.log.debug({ practiceCount: practiceContext.practices.length }, 'AI context loaded');

        const interpretation = await deps.interpreterService.interpretWithDetails(
          validation.value,
          {
            tenantId: auth.tenantId,
            userId: auth.userId ?? null,
            practices: practiceContext.practices,
          },
        );

        const normalized = enforceIdPriority(
          deps.normalizerService.normalize(interpretation.output),
        );
        req.log.debug(
          { action: normalized.action, nextState: normalized.nextState },
          'AI command resolved',
        );

        let finalResult: unknown;
        let isSuccess = false;
        let failureError: unknown;

        if (normalized.action === 'create_practice') {
          const executorCtx = { tenantId: auth.tenantId, userId: auth.userId, role: auth.role };
          const createCmd = {
            action: 'create_practice',
            data: { artistName: normalized.artistName },
          };
          const created = await deps.executorService.execute(createCmd, executorCtx);
          if (created.success) {
            isSuccess = true;
            finalResult = created.result;
          } else {
            isSuccess = false;
            failureError = created.error;
          }
        } else {
          // AI execution is open to every authenticated role, but state-changing
          // practice transitions remain restricted to ADMIN/OPERATOR.
          if (normalized.action === 'transition_practice') {
            authorize(auth, 'practice.transition');
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
            role: auth.role,
          };
          const result = await deps.executorService.execute(resolved, executorCtx);
          if (result.success) {
            isSuccess = true;
            finalResult = result.result;
          } else {
            isSuccess = false;
            failureError = result.error;
          }
        }

        const latencyMs = Math.round(performance.now() - startTime);
        const isClarification =
          (finalResult as { type?: string })?.type === 'clarification_required';
        const isSecurityBlocked =
          typeof (finalResult as { reason?: string })?.reason === 'string' &&
          (finalResult as { reason?: string }).reason?.startsWith('SECURITY_INJECTION_BLOCKED');

        const trace: AITraceRecord = {
          requestId,
          tenantId: auth.tenantId,
          userId: auth.userId,
          model: interpretation.traceMeta.model,
          provider: interpretation.traceMeta.provider,
          tokens: interpretation.traceMeta.tokens,
          latencyMs,
          outcome: isSecurityBlocked
            ? 'SECURITY_REJECTED'
            : isClarification
              ? 'AMBIGUOUS'
              : isSuccess
                ? 'SUCCESS'
                : 'ERROR',
          action: isClarification ? 'clarification_required' : normalized.action,
          error: isSuccess ? undefined : String(failureError),
          timestamp: new Date().toISOString(),
        };
        tracer.record(trace);

        if (isSuccess) {
          return reply.status(200).send({ success: true, result: finalResult, meta: { trace } });
        }
        return reply.status(200).send({ success: false, error: failureError, meta: { trace } });
      } catch (err: unknown) {
        const latencyMs = Math.round(performance.now() - startTime);
        const mapped = mapErrorToHttp(err);

        const isAmbiguous =
          mapped.code === 'INTERPRETER_ERROR' &&
          typeof mapped.message === 'string' &&
          mapped.message.toLowerCase().includes('ambiguous');

        const trace: AITraceRecord = {
          requestId,
          tenantId,
          userId,
          model: deps.interpreterService.getModelName?.() ?? 'unknown',
          provider: deps.interpreterService.getProviderName?.() ?? 'unknown',
          latencyMs,
          outcome: isAmbiguous
            ? 'AMBIGUOUS'
            : mapped.code === 'LLM_DISABLED'
              ? 'LLM_DISABLED'
              : 'ERROR',
          error: mapped.code,
          timestamp: new Date().toISOString(),
        };
        tracer.record(trace);

        return reply.status(mapped.statusCode).send({
          ...fail(mapped.code, mapped.message),
          meta: { trace },
        });
      }
    },
  );
  done();
};
