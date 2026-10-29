import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { runtimeState } from '../../runtime/runtime.state.js';

import { createAuthHook } from './auth/auth.hook.js';
import { AuthService } from './auth/auth.service.js';
import { requireAuthContext } from './auth/guards.js';
import { buildRateLimitOptions, createTenantLimiter } from './middleware/rate-limit.js';
import { requestContextHook } from './middleware/request-context.js';
import { aiRoutes } from './routes/ai.routes.js';
import { complianceRoutes } from './routes/compliance.routes.js';
import { practiceRoutes } from './routes/practice.routes.js';
import { whatsappRoutes, type WhatsAppRoutesOptions } from './routes/whatsapp.routes.js';

import type { ContextService } from '../../ai/context/context.service.js';
import type { DecisionEngine } from '../../ai/decision/decision.engine.js';
import type { ExecutorService } from '../../ai/execution/executor.service.js';
import type { InterpreterService } from '../../ai/interpreter/interpreter.service.js';
import type { NormalizerService } from '../../ai/normalization/normalizer.service.js';
import type { AITracer } from '../../ai/tracing/ai.tracer.js';
import type { AppConfig } from '../../config/config.js';
import type { ComplianceService } from '../../core/compliance/compliance.service.js';
import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';
import type { AppLogger } from '../../shared/logger.js';

export type ServerDeps = {
  practiceService: PracticeApplicationService;
  // Optional so that tests and tools can build the server without the compliance module.
  complianceService?: ComplianceService;
  // Present only when the WhatsApp channel is configured.
  whatsappWebhook?: WhatsAppRoutesOptions;
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

  // Security headers, per-user/per-tenant request limits (stricter on the AI endpoint).
  const limits = {
    perUserPerMinute: config.RATE_LIMIT_PER_MINUTE,
    aiPerMinute: config.RATE_LIMIT_AI_PER_MINUTE,
    perTenantPerMinute: config.RATE_LIMIT_TENANT_PER_MINUTE,
  };
  // Both plugins are registered on the root instance (not encapsulated), before the routes.
  void app.register(helmet);
  void app.register(rateLimit, buildRateLimitOptions(limits));
  app.addHook('preHandler', createTenantLimiter(limits.perTenantPerMinute));

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
  if (deps.whatsappWebhook) {
    void app.register(whatsappRoutes, deps.whatsappWebhook);
  }
  if (deps.complianceService) {
    void app.register(complianceRoutes, { complianceService: deps.complianceService });
  }

  // Future-ready: auth middleware, rate limiting (structure only).
  return app;
}
