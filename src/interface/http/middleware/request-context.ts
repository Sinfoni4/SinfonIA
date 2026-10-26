import { randomUUID } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

export type RequestContext = {
  requestId: string;
  tenantId: string | null;
  userId: string | null;
};

const CONTEXT_KEY = 'requestContext' as const;

export function createRequestContext(req: FastifyRequest): RequestContext {
  const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
  const tenantIdHeader = req.headers['x-tenant-id'];
  const tenantId =
    typeof tenantIdHeader === 'string' && tenantIdHeader.trim() ? tenantIdHeader.trim() : null;
  const userIdHeader = req.headers['x-user-id'];
  const userId =
    typeof userIdHeader === 'string' && userIdHeader.trim() ? userIdHeader.trim() : null;

  return { requestId, tenantId, userId };
}

export function attachRequestContext(req: FastifyRequest, ctx: RequestContext): void {
  (req as FastifyRequest & { [CONTEXT_KEY]: RequestContext })[CONTEXT_KEY] = ctx;
}

export function getRequestContext(req: FastifyRequest): RequestContext | null {
  return (req as FastifyRequest & { [CONTEXT_KEY]?: RequestContext })[CONTEXT_KEY] ?? null;
}

export function requestContextHook(
  req: FastifyRequest,
  _reply: unknown,
  done: (err?: Error) => void,
): void {
  const ctx = createRequestContext(req);
  attachRequestContext(req, ctx);
  // Correlation: bind requestId, tenantId, userId so they appear in all request-scoped logs.
  const bindings = {
    requestId: ctx.requestId,
    tenantId: ctx.tenantId ?? undefined,
    userId: ctx.userId ?? undefined,
  };
  (req as { log: FastifyRequest['log'] }).log = req.log.child(bindings);
  done();
}
