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
  sid: z.string().uuid().optional(),
  ver: z.number().int().nonnegative().optional(),
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
  input: {
    tenantId: string;
    userId: string;
    role: AuthClaims['role'];
    ttlSeconds?: number;
    sessionId?: string;
    authVersion?: number;
  },
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
      ...(input.sessionId ? { sid: input.sessionId } : {}),
      ...(input.authVersion !== undefined ? { ver: input.authVersion } : {}),
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

/**
 * Platform console token (G1): another audience and a `scp` claim, no organization and no role.
 * An organization token is refused by the console and a console token by every organization route,
 * because each side checks its own audience.
 */
const PlatformClaimsSchema = z.object({
  sub: z.string().uuid(),
  scp: z.literal('platform'),
  sid: z.string().uuid(),
  ver: z.number().int().nonnegative(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  iss: z.string().min(1),
  aud: z.string().min(1),
});

export type PlatformClaims = z.infer<typeof PlatformClaimsSchema>;

export function platformAudience(config: AuthConfig): string {
  return `${config.audience}#platform`;
}

export function issuePlatformToken(
  input: { userId: string; sessionId: string; authVersion: number; ttlSeconds: number },
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: input.userId,
      scp: 'platform',
      sid: input.sessionId,
      ver: input.authVersion,
      iat: nowSeconds,
      exp: nowSeconds + Math.min(3600, Math.max(60, Math.floor(input.ttlSeconds))),
      iss: config.issuer,
      aud: platformAudience(config),
    }),
  );
  return `${header}.${payload}.${sign(header, payload, config.secret)}`;
}

export function verifyPlatformToken(
  token: string,
  config: AuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): PlatformClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed bearer token', 'INVALID_TOKEN');
  const [headerPart, payloadPart, signaturePart] = parts;
  const provided = base64UrlDecode(signaturePart);
  const expected = base64UrlDecode(sign(headerPart, payloadPart, config.secret));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
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
  if (!HeaderSchema.safeParse(header).success) {
    throw new AuthError('Unsupported bearer token algorithm', 'INVALID_TOKEN');
  }
  const parsed = PlatformClaimsSchema.safeParse(payload);
  if (!parsed.success) throw new AuthError('Not a platform token', 'INVALID_TOKEN');
  const claims = parsed.data;
  if (claims.iss !== config.issuer || claims.aud !== platformAudience(config)) {
    throw new AuthError('Not a platform token', 'INVALID_TOKEN');
  }
  if (claims.iat > nowSeconds + 60) {
    throw new AuthError('Bearer token issued in the future', 'INVALID_TOKEN');
  }
  if (claims.exp <= nowSeconds) throw new AuthError('Bearer token expired', 'TOKEN_EXPIRED');
  return claims;
}
