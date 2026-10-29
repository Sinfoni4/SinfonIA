import { z } from 'zod';

import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { LoginService } from '../../../core/identity/login.service.js';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type AuthRoutesDeps = {
  login: LoginService;
  /** Issues the access token of an organization (10 minutes, with session and auth version). */
  issueAccessToken: (grant: {
    tenantId: string;
    userId: string;
    role: 'ADMIN' | 'OPERATOR' | 'MEMBER';
    sessionId: string;
    authVersion: number;
  }) => string;
  accessTokenTtlSeconds: number;
  /** Requests per address and minute on each login route. */
  perMinute: number;
};

const StartSchema = z.object({ email: z.string().trim().min(3).max(254) });
const VerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});
const TokenSchema = z.object({
  refreshToken: z.string().min(10).max(200),
  orgId: z.string().uuid(),
});
const LogoutSchema = z.object({ refreshToken: z.string().min(10).max(200) });
const InvitationStartSchema = z.object({ token: z.string().min(20).max(200) });
const InvitationAcceptSchema = InvitationStartSchema.extend({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

/**
 * Login with a one-time code by email, access tokens per organization and invitations (MF6).
 * Registered only when email login is enabled (AUTH_EMAIL_LOGIN).
 */
export const authRoutes: FastifyPluginCallback<AuthRoutesDeps> = (app, deps, done) => {
  // Public (no token yet, see PUBLIC_PATHS): stricter per-address limits.
  const LIMIT = { rateLimit: { max: deps.perMinute, timeWindow: '1 minute' } };
  const handle =
    <T>(schema: z.ZodType<T>, run: (body: T) => Promise<unknown>, status = 200) =>
    async (req: { body: unknown }, reply: FastifyReply) => {
      try {
        const result = await run(schema.parse(req.body));
        return result === undefined
          ? reply.status(204).send()
          : reply.status(status).send(ok(result));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    };

  app.post(
    '/auth/login/start',
    { config: LIMIT },
    handle(StartSchema, (b) => deps.login.startLogin(b.email), 202),
  );
  app.post(
    '/auth/login/verify',
    { config: LIMIT },
    handle(VerifySchema, (b) => deps.login.verifyLogin(b.challengeId, b.code)),
  );
  app.post(
    '/auth/token',
    { config: LIMIT },
    handle(TokenSchema, async (b) => {
      const grant = await deps.login.refresh(b.refreshToken, b.orgId);
      return {
        accessToken: deps.issueAccessToken({
          tenantId: grant.orgId,
          userId: grant.userId,
          role: grant.role,
          sessionId: grant.sessionId,
          authVersion: grant.authVersion,
        }),
        expiresIn: deps.accessTokenTtlSeconds,
        refreshToken: grant.refreshToken,
      };
    }),
  );
  app.post(
    '/auth/logout',
    { config: LIMIT },
    handle(LogoutSchema, async (b) => {
      await deps.login.logout(b.refreshToken);
      return undefined;
    }),
  );
  app.post(
    '/auth/invitations/start',
    { config: LIMIT },
    handle(InvitationStartSchema, (b) => deps.login.startInvitation(b.token)),
  );
  app.post(
    '/auth/invitations/accept',
    { config: LIMIT },
    handle(InvitationAcceptSchema, (b) =>
      deps.login.acceptInvitation(b.token, b.challengeId, b.code),
    ),
  );

  done();
};
