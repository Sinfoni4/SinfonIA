import {
  authorize,
  type Grant,
  type Principal,
} from '../../../core/authz/authorization.service.js';
import { getRequestContext } from '../middleware/request-context.js';

import { AuthError } from './auth.errors.js';

import type { AuthContext } from './auth.types.js';
import type { Permission } from '../../../core/authz/permissions.js';
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

export function requirePrincipal(req: FastifyRequest): Principal {
  return { ...requireAuthContext(req), extraPermissions: getRequestContext(req)?.extraPermissions };
}

/** Grants the permission to the authenticated caller, or throws PermissionDeniedError (403). */
export function requirePermission(req: FastifyRequest, permission: Permission): Grant {
  return authorize(requirePrincipal(req), permission);
}

/** The platform administrator of a console request (G1); the hook has already checked it. */
export function requirePlatform(req: FastifyRequest): {
  userId: string;
  sessionId: string;
  email: string;
} {
  const platform = getRequestContext(req)?.platform;
  if (!platform) throw new AuthError('Platform authentication required', 'MISSING_TOKEN');
  return platform;
}
