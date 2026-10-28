import { z } from 'zod';

export const AuthRoleSchema = z.enum(['ADMIN', 'OPERATOR', 'MEMBER']);
export type AuthRole = z.infer<typeof AuthRoleSchema>;

export type AuthClaims = {
  sub: string;
  tid: string;
  role: AuthRole;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
};

export type AuthContext = {
  tenantId: string;
  userId: string;
  role: AuthRole;
};

export type AuthConfig = {
  secret: string;
  issuer: string;
  audience: string;
  defaultTtlSeconds: number;
};

export const AUTH_ROLES = {
  PRACTICE_READ: ['ADMIN', 'OPERATOR', 'MEMBER'] as const,
  PRACTICE_CREATE: ['ADMIN', 'OPERATOR', 'MEMBER'] as const,
  PRACTICE_EXPORT: ['ADMIN', 'OPERATOR', 'MEMBER'] as const,
  PRACTICE_TRANSITION: ['ADMIN', 'OPERATOR'] as const,
  AI_EXECUTE: ['ADMIN', 'OPERATOR', 'MEMBER'] as const,
  AUDIT_READ: ['ADMIN'] as const,
  COMPLIANCE_READ: ['ADMIN', 'OPERATOR', 'MEMBER'] as const,
  COMPLIANCE_MANAGE: ['ADMIN', 'OPERATOR'] as const,
} satisfies Record<string, readonly AuthRole[]>;
