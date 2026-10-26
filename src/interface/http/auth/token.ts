import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { AuthError } from './auth.errors.js';
import { AuthRoleSchema, type AuthClaims, type AuthConfig } from './auth.types.js';

const HeaderSchema = z.object({
  alg: z.literal('HS256'),
  typ: z.literal('JWT').optional(),
});

const ClaimsSchema = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  role: AuthRoleSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  iss: z.string().min(1),
  aud: z.string().min(1),
});

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function sign(header: string, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
}

export function issueAuthToken(
  input: { tenantId: string; userId: string; role: AuthClaims['role']; ttlSeconds?: number },
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const iat = nowSeconds;
  const requestedTtl = input.ttlSeconds ?? config.defaultTtlSeconds;
  const ttlSeconds = Number.isFinite(requestedTtl)
    ? Math.min(86_400, Math.max(60, Math.floor(requestedTtl)))
    : config.defaultTtlSeconds;
  const exp = iat + ttlSeconds;
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: input.userId,
      tid: input.tenantId,
      role: input.role,
      iat,
      exp,
      iss: config.issuer,
      aud: config.audience,
    }),
  );
  const signature = sign(header, payload, config.secret);
  return `${header}.${payload}.${signature}`;
}

export function verifyAuthToken(
  token: string,
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): AuthClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError('Malformed bearer token', 'INVALID_TOKEN');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const expected = sign(headerPart, payloadPart, config.secret);
  const provided = base64UrlDecode(signaturePart);
  const expectedBuffer = base64UrlDecode(expected);

  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    throw new AuthError('Invalid bearer token signature', 'INVALID_TOKEN');
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadPart).toString('utf8'));
  } catch {
    throw new AuthError('Malformed bearer token payload', 'INVALID_TOKEN');
  }

  const parsedHeader = HeaderSchema.safeParse(header);
  if (!parsedHeader.success) {
    throw new AuthError('Unsupported bearer token algorithm', 'INVALID_TOKEN');
  }

  const parsedClaims = ClaimsSchema.safeParse(payload);
  if (!parsedClaims.success) {
    throw new AuthError('Invalid bearer token claims', 'INVALID_TOKEN');
  }

  const claims = parsedClaims.data;
  if (claims.iss !== config.issuer || claims.aud !== config.audience) {
    throw new AuthError('Invalid bearer token issuer or audience', 'INVALID_TOKEN');
  }
  if (claims.iat > nowSeconds + 60) {
    throw new AuthError('Bearer token issued in the future', 'INVALID_TOKEN');
  }
  if (claims.exp <= nowSeconds) {
    throw new AuthError('Bearer token expired', 'TOKEN_EXPIRED');
  }

  return claims;
}
