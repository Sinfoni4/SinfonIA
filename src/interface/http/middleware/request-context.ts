import { randomUUID } from 'node:crypto';

import type { AuthContext, AuthRole } from '../auth/auth.types.js';
import type { FastifyRequest } from 'fastify';

export type RequestContext = {
  requestId: string;
  tenantId: string | null;
  userId: string | null;
  role: AuthRole | null;
};

const CONTEXT_KEY = 'requestContext' as const;

export function createRequestContext(req: FastifyRequest): RequestContext {
  const rawRequestId = req.headers['x-request-id'];
  const requestId =
    typeof rawRequestId === 'string' && rawRequestId.trim().length > 0
      ? rawRequestId.trim().slice(0, 128)
      : randomUUID();

  // Tenant and user identity are NEVER read from client headers.
  // They are populated only by the authenticated bearer-token hook.
  return { requestId, tenantId: null, userId: null, role: null };
}

export function attachRequestContext(req: FastifyRequest, ctx: RequestContext): void {
  (req as FastifyRequest & { [CONTEXT_KEY]: RequestContext })[CONTEXT_KEY] = ctx;
}

export function getRequestContext(req: FastifyRequest): RequestContext | null {
  return (req as FastifyRequest & { [CONTEXT_KEY]?: RequestContext })[CONTEXT_KEY] ?? null;
}

export function attachAuthenticatedContext(req: FastifyRequest, auth: AuthContext): void {
  const ctx = getRequestContext(req);
  if (!ctx) {
    throw new Error('Request context must be created before authentication');
  }
  ctx.tenantId = auth.tenantId;
  ctx.userId = auth.userId;
  ctx.role = auth.role;
}

export function requestContextHook(
  req: FastifyRequest,
  _reply: unknown,
  done: (err?: Error) => void,
): void {
  const ctx = createRequestContext(req);
  attachRequestContext(req, ctx);
  req.log = req.log.child({ requestId: ctx.requestId });
  done();
}
