import { issueAuthToken } from '../../src/interface/http/auth/token.js';

import type { AuthConfig, AuthRole } from '../../src/interface/http/auth/auth.types.js';

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
