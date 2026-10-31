import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import {
  attachAuthenticatedContext,
  attachPlatformContext,
} from '../middleware/request-context.js';

import { AuthError } from './auth.errors.js';

import type { AuthService } from './auth.service.js';
import type { PrincipalResolver } from '../../../core/authz/authorization.service.js';
import type { PlatformPrincipal } from '../../../core/authz/platform.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// The WhatsApp webhook authenticates Meta's requests by signature, not by JWT.
export const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/webhooks/whatsapp',
  // Email login (MF6): the caller has no token yet; registered only when enabled.
  '/auth/login/start',
  '/auth/login/verify',
  '/auth/token',
  '/auth/platform-token',
  '/auth/logout',
  '/auth/invitations/start',
  '/auth/invitations/accept',
]);

/**
 * The built dashboard (B2) is public: the page holds no data, and every API call it makes is
 * authenticated like any other.
 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path === '/app' || path.startsWith('/app/');
}

export function createAuthHook(
  authService: AuthService,
  principals: PrincipalResolver,
  /** The platform console (G1); absent: every /platform/ request is refused. */
  platform?: (identity: {
    userId: string;
    sessionId: string;
    authVersion: number;
  }) => Promise<PlatformPrincipal>,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = req.url.split('?')[0] ?? req.url;
    if (isPublicPath(path)) return;

    if (path.startsWith('/platform/')) {
      try {
        // Only a platform token, checked against the database at every request.
        const identity = authService.authenticatePlatform(req.headers.authorization);
        if (!platform) throw new AuthError('Platform console not available', 'INVALID_TOKEN');
        const principal = await platform(identity);
        attachPlatformContext(req, principal);
        req.log = req.log.child({ platformUserId: principal.userId });
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        await reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
      return;
    }

    try {
      const claims = authService.authenticate(req.headers.authorization);
      // The role comes from the database, not from the token: a changed or removed user loses
      // the old rights at the next request.
      const principal = await principals({
        tenantId: claims.tenantId,
        userId: claims.userId,
        tokenRole: claims.role,
        authVersion: claims.authVersion,
        ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
      });
      if (!principal) {
        throw new AuthError('User not found in tenant', 'INVALID_TOKEN');
      }
      const auth = principal;
      attachAuthenticatedContext(req, auth);
      req.log = req.log.child({
        tenantId: auth.tenantId,
        userId: auth.userId,
        role: auth.role,
      });
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      await reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  };
}
