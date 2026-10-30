import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The refresh token of a login session lives in a cookie a script cannot read (B1,
 * docs/PROGETTO_FRONTEND_V1.md §4): HttpOnly, Secure, SameSite=Strict, sent only to /auth.
 * The access token (10 minutes) stays in the page's memory.
 */
export const REFRESH_COOKIE = 'sinfonia_refresh';

const ATTRIBUTES = 'Path=/auth; HttpOnly; Secure; SameSite=Strict';

export function setRefreshCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`);
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`);
}

/** The refresh token sent by the browser, if any. */
export function readRefreshCookie(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) {
      const value = rest.join('=');
      return value || undefined;
    }
  }
  return undefined;
}
