import { getRequestContext } from '../middleware/request-context.js';

import { AuthError } from './auth.errors.js';

import type { AuthContext, AuthRole } from './auth.types.js';
import type { FastifyRequest } from 'fastify';

export function requireAuthContext(req: FastifyRequest): AuthContext {
  const ctx = getRequestContext(req);
  if (!ctx?.tenantId || !ctx.userId || !ctx.role) {
    throw new AuthError('Authentication required', 'MISSING_TOKEN');
  }

  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: ctx.role,
  };
}

export function requireRole(req: FastifyRequest, allowedRoles: readonly AuthRole[]): AuthContext {
  const ctx = requireAuthContext(req);
  if (!allowedRoles.includes(ctx.role)) {
    throw new AuthError('Insufficient role for this operation', 'FORBIDDEN', 403);
  }
  return ctx;
}
