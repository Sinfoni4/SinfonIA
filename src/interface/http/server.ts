import multipart from '@fastify/multipart';
import Fastify from 'fastify';

import { runtimeState } from '../../runtime/runtime.state.js';

import { createAuthHook } from './auth/auth.hook.js';
import { AuthService } from './auth/auth.service.js';
import { requireAuthContext } from './auth/guards.js';
import { requestContextHook } from './middleware/request-context.js';
import { aiRoutes } from './routes/ai.routes.js';
import { practiceRoutes } from './routes/practice.routes.js';

import type { ContextService } from '../../ai/context/context.service.js';
import type { DecisionEngine } from '../../ai/decision/decision.engine.js';
import type { ExecutorService } from '../../ai/execution/executor.service.js';
import type { InterpreterService } from '../../ai/interpreter/interpreter.service.js';
import type { NormalizerService } from '../../ai/normalization/normalizer.service.js';
import type { AITracer } from '../../ai/tracing/ai.tracer.js';
import type { AppConfig } from '../../config/config.js';
import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';
import type { AppLogger } from '../../shared/logger.js';

export type ServerDeps = {
  practiceService: PracticeApplicationService;
  interpreterService: InterpreterService;
  executorService: ExecutorService;
  contextService: ContextService;
  decisionEngine: DecisionEngine;
  normalizerService: NormalizerService;
  tracer?: AITracer;
};

export function buildServer(config: AppConfig, logger: AppLogger, deps: ServerDeps) {
  // Interface Layer: HTTP transport only.
  // No business logic here. No direct DB access. No AI calls.
  const app = Fastify({
    loggerInstance: logger,
  });

  // Request context and logging correlation (requestId).
  app.addHook('onRequest', requestContextHook);

  // Authentication is required for every route except liveness/readiness.
  const authService = new AuthService({
    secret: config.AUTH_SECRET,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    defaultTtlSeconds: config.AUTH_TTL_SECONDS,
  });
  app.addHook('onRequest', createAuthHook(authService));

  // Liveness: the process can answer HTTP.
  app.get('/healthz', () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    mode: runtimeState.getMode(),
  }));

  // Readiness: traffic can be served only while the database is reachable.
  app.get('/readyz', (_req, reply) => {
    const snapshot = runtimeState.snapshot();
    const ready = snapshot.dbReachable && snapshot.mode !== 'CIRCUIT_OPEN';

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: {
          reachable: snapshot.dbReachable,
          lastCheck: snapshot.lastDbCheck,
        },
      },
    });
  });

  app.get('/auth/whoami', (req) => {
    const auth = requireAuthContext(req);
    return {
      subject: auth.userId,
      tenantId: auth.tenantId,
      role: auth.role,
    };
  });

  // Multipart uploads: one file per request, size capped at the attachment limit.
  void app.register(multipart, {
    limits: { fileSize: config.ATTACHMENT_MAX_BYTES, files: 1, fields: 5 },
  });

  // Routes (HTTP only): business logic lives in Core / AI.
  void app.register(practiceRoutes, { ...deps, maxAttachmentBytes: config.ATTACHMENT_MAX_BYTES });
  void app.register(aiRoutes, deps);

  // Future-ready: auth middleware, rate limiting (structure only).
  return app;
}
