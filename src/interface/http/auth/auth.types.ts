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
  /** Login session (MF6); tokens without it are only valid until the next global revocation. */
  sid?: string;
  /** auth_version of the person when the token was issued (MF5). */
  ver?: number;
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
