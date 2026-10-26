import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import { attachAuthenticatedContext } from '../middleware/request-context.js';

import type { AuthService } from './auth.service.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);

export function createAuthHook(authService: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;

    try {
      const auth = authService.authenticate(req.headers.authorization);
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
