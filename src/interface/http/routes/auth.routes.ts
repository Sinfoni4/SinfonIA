import { z } from 'zod';

import { SESSION_TTL_MS } from '../../../core/identity/login.service.js';
import { LoginError } from '../../../core/identity/login.service.js';
import { requireAuthContext } from '../auth/guards.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../auth/refresh-cookie.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { LoginService, LoginSession } from '../../../core/identity/login.service.js';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

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
const TokenSchema = z.object({ orgId: z.string().uuid() });
const InvitationStartSchema = z.object({ token: z.string().min(20).max(200) });
const InvitationAcceptSchema = InvitationStartSchema.extend({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/**
 * Login with a one-time code by email, access tokens per organization and invitations (MF6).
 * The refresh token is only ever in an HttpOnly cookie (B1). Registered only when email login is
 * enabled (AUTH_EMAIL_LOGIN).
 */
export const authRoutes: FastifyPluginCallback<AuthRoutesDeps> = (app, deps, done) => {
  // Public (no token yet, see PUBLIC_PATHS): stricter per-address limits.
  const LIMIT = { rateLimit: { max: deps.perMinute, timeWindow: '1 minute' } };
  const handle =
    <T>(
      schema: z.ZodType<T>,
      run: (body: T, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
      status = 200,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await run(schema.parse(req.body ?? {}), req, reply);
        return result === undefined
          ? reply.status(204).send()
          : reply.status(status).send(ok(result));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    };

  /** Opens the session in the browser: the refresh token goes to the cookie, not to the page. */
  const openSession = (session: LoginSession, reply: FastifyReply) => {
    setRefreshCookie(reply, session.refreshToken, SESSION_TTL_SECONDS);
    return {
      userId: session.userId,
      sessionId: session.sessionId,
      organizations: session.organizations,
    };
  };

  app.post(
    '/auth/login/start',
    { config: LIMIT },
    handle(StartSchema, (b) => deps.login.startLogin(b.email), 202),
  );
  app.post(
    '/auth/login/verify',
    { config: LIMIT },
    handle(VerifySchema, async (b, _req, reply) =>
      openSession(await deps.login.verifyLogin(b.challengeId, b.code), reply),
    ),
  );
  app.post(
    '/auth/token',
    { config: LIMIT },
    handle(TokenSchema, async (b, req, reply) => {
      const refreshToken = readRefreshCookie(req);
      if (!refreshToken) throw new LoginError();
      // A failure (wrong organization, revoked session) leaves the cookie: the server refuses a
      // revoked session anyway, and a wrong organization must not log the person out.
      const grant = await deps.login.refresh(refreshToken, b.orgId);
      setRefreshCookie(reply, grant.refreshToken, SESSION_TTL_SECONDS);
      return {
        accessToken: deps.issueAccessToken({
          tenantId: grant.orgId,
          userId: grant.userId,
          role: grant.role,
          sessionId: grant.sessionId,
          authVersion: grant.authVersion,
        }),
        expiresIn: deps.accessTokenTtlSeconds,
      };
    }),
  );
  app.post(
    '/auth/logout',
    { config: LIMIT },
    handle(z.object({}).passthrough(), async (_b, req, reply) => {
      const refreshToken = readRefreshCookie(req);
      if (refreshToken) await deps.login.logout(refreshToken);
      clearRefreshCookie(reply);
      return undefined;
    }),
  );
  // Not public: the person is authenticated with the access token (B4).
  app.post(
    '/auth/logout-all',
    { config: { permission: 'authenticated' } },
    handle(z.object({}).passthrough(), async (_b, req, reply) => {
      await deps.login.logoutEverywhere(requireAuthContext(req).userId);
      clearRefreshCookie(reply);
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
    handle(InvitationAcceptSchema, async (b, _req, reply) =>
      openSession(await deps.login.acceptInvitation(b.token, b.challengeId, b.code), reply),
    ),
  );

  done();
};
