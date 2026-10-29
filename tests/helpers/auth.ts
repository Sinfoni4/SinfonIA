import { createPrismaPrincipalResolver } from '../../src/core/authz/authorization.service.js';
import { issueAuthToken } from '../../src/interface/http/auth/token.js';

import type { PrincipalResolver } from '../../src/core/authz/authorization.service.js';
import type { AuthConfig, AuthRole } from '../../src/interface/http/auth/auth.types.js';
import type { PrismaClient } from '@prisma/client';

export const TEST_AUTH_SECRET = 'test-only-sinfonia-auth-secret-32chars';

export const TEST_AUTH_CONFIG: AuthConfig = {
  secret: TEST_AUTH_SECRET,
  issuer: 'sinfonia',
  audience: 'sinfonia-api',
  defaultTtlSeconds: 3600,
};

export const TEST_AUTH_ENV = {
  AUTH_SECRET: TEST_AUTH_SECRET,
  AUTH_ISSUER: TEST_AUTH_CONFIG.issuer,
  AUTH_AUDIENCE: TEST_AUTH_CONFIG.audience,
  AUTH_TTL_SECONDS: String(TEST_AUTH_CONFIG.defaultTtlSeconds),
} as const;

export function authHeaders(
  tenantId: string,
  userId: string,
  role: AuthRole = 'ADMIN',
): { authorization: string } {
  const token = issueAuthToken({ tenantId, userId, role }, TEST_AUTH_CONFIG);
  return { authorization: `Bearer ${token}` };
}

/**
 * Principal resolver for tests: the real database lookup when a client is given, otherwise the
 * role written in the token (tests that run without a database).
 */
export function testPrincipals(prisma?: Pick<PrismaClient, 'user'>): PrincipalResolver {
  if (prisma) return createPrismaPrincipalResolver(prisma);
  return ({ tenantId, userId, tokenRole }) =>
    Promise.resolve({ tenantId, userId, role: tokenRole });
}
