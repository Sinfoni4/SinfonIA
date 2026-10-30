import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import { attachAuthenticatedContext } from '../middleware/request-context.js';

import { AuthError } from './auth.errors.js';

import type { AuthService } from './auth.service.js';
import type { PrincipalResolver } from '../../../core/authz/authorization.service.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// The WhatsApp webhook authenticates Meta's requests by signature, not by JWT.
export const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/webhooks/whatsapp']);

export function createAuthHook(authService: AuthService, principals: PrincipalResolver) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;

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
