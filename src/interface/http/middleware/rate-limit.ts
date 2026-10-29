import { fail } from '../errors/http.errors.js';

import { getRequestContext } from './request-context.js';

import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type RateLimitOptions = {
  /** Requests per minute for one user (or one IP when unauthenticated). */
  perUserPerMinute: number;
  /** Requests per minute for one user on the AI endpoint, which calls the paid LLM. */
  aiPerMinute: number;
  /** Requests per minute for a whole tenant, all its users together. */
  perTenantPerMinute: number;
};

// Liveness/readiness probes and Meta's webhook (authenticated by signature) are not limited.
const UNLIMITED_PATHS = new Set(['/healthz', '/readyz', '/webhooks/whatsapp']);
const AI_PATH = '/ai/execute';
const WINDOW_MS = 60_000;

const pathOf = (req: FastifyRequest) => req.url.split('?')[0] ?? req.url;

function identityKey(req: FastifyRequest): string {
  const ctx = getRequestContext(req);
  return ctx?.tenantId && ctx.userId ? `user:${ctx.tenantId}:${ctx.userId}` : `ip:${req.ip}`;
}

const RATE_LIMITED = 'Troppe richieste: riprova tra poco.';

/**
 * Fixed-window limit for a whole tenant, on top of the per-user one: many users of one cooperative
 * cannot saturate the service for the others. In memory, like the per-user limit: with several
 * instances behind a load balancer both need a shared store (Redis).
 */
export function createTenantLimiter(perMinute: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (UNLIMITED_PATHS.has(pathOf(req))) return;
    const tenantId = getRequestContext(req)?.tenantId;
    if (!tenantId) return;
    const t = now();
    let window = windows.get(tenantId);
    if (!window || t - window.start >= WINDOW_MS) {
      window = { start: t, count: 0 };
      windows.set(tenantId, window);
    }
    window.count++;
    if (window.count > perMinute) {
      const retryAfter = Math.ceil((window.start + WINDOW_MS - t) / 1000);
      await reply
        .status(429)
        .header('retry-after', String(retryAfter))
        .send(fail('RATE_LIMITED', RATE_LIMITED));
    }
  };
}

/**
 * Options of the per-user limit. It runs after authentication (preHandler), so it keys on the
 * authenticated user rather than on the IP shared by a whole office.
 */
export function buildRateLimitOptions(options: RateLimitOptions): RateLimitPluginOptions {
  return {
    global: true,
    hook: 'preHandler',
    timeWindow: WINDOW_MS,
    max: (req) => (pathOf(req) === AI_PATH ? options.aiPerMinute : options.perUserPerMinute),
    // The AI endpoint has its own bucket, so heavy AI use does not consume the general quota.
    keyGenerator: (req) => (pathOf(req) === AI_PATH ? `ai:${identityKey(req)}` : identityKey(req)),
    allowList: (req) => UNLIMITED_PATHS.has(pathOf(req)),
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      ...fail('RATE_LIMITED', RATE_LIMITED),
    }),
  };
}
