import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail } from '../errors/http.errors.js';
import { attachAuthenticatedContext, attachTokenIdentity } from '../middleware/request-context.js';

import { AuthError } from './auth.errors.js';

import type { AuthService } from './auth.service.js';
import type { Principal, PrincipalResolver } from '../../../core/authz/authorization.service.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// The WhatsApp webhook authenticates Meta's requests by signature, not by JWT.
export const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/webhooks/whatsapp']);

const isPublic = (req: FastifyRequest) => PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url);

/**
 * Two hooks: onRequest checks the token and starts loading the caller's role from the database;
 * preHandler waits for it, so the lookup overlaps the work in between (rate limit, body parsing).
 * The role comes from the database, not from the token: a changed or removed user loses the old
 * rights at the next request.
 */
export function createAuthHook(authService: AuthService, principals: PrincipalResolver) {
  const pending = new WeakMap<FastifyRequest, Promise<Principal | null | Error>>();

  const sendError = async (reply: FastifyReply, err: unknown) => {
    const mapped = mapErrorToHttp(err);
    await reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
  };

  return {
    onRequest: async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (isPublic(req)) return;
      try {
        const claims = authService.authenticate(req.headers.authorization);
        // Signed identity, available right away to the per-user and per-tenant rate limits.
        attachTokenIdentity(req, { tenantId: claims.tenantId, userId: claims.userId });
        // Errors become values: nothing is left unhandled if the request ends early.
        pending.set(
          req,
          principals({
            tenantId: claims.tenantId,
            userId: claims.userId,
            tokenRole: claims.role,
          }).catch((err: unknown) =>
            err instanceof Error ? err : new Error('Principal lookup failed'),
          ),
        );
      } catch (err: unknown) {
        await sendError(reply, err);
      }
    },

    preHandler: async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (isPublic(req)) return;
      try {
        const principal = await pending.get(req);
        if (principal instanceof Error) throw principal;
        if (!principal) {
          throw new AuthError('User not found in tenant', 'INVALID_TOKEN');
        }
        attachAuthenticatedContext(req, principal);
        req.log = req.log.child({
          tenantId: principal.tenantId,
          userId: principal.userId,
          role: principal.role,
        });
      } catch (err: unknown) {
        await sendError(reply, err);
      }
    },
  };
}
