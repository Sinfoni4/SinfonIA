import { AuthError } from './auth.errors.js';
import {
  issueAuthToken,
  issuePlatformToken,
  verifyAuthToken,
  verifyPlatformToken,
} from './token.js';

import type { AuthClaims, AuthConfig, AuthContext } from './auth.types.js';

export class AuthService {
  constructor(private readonly config: AuthConfig) {}

  issue(input: {
    tenantId: string;
    userId: string;
    role: AuthClaims['role'];
    ttlSeconds?: number;
    sessionId?: string;
    authVersion?: number;
  }): string {
    return issueAuthToken(input, this.config);
  }

  verify(token: string): AuthClaims {
    return verifyAuthToken(token, this.config);
  }

  authenticate(
    authorizationHeader: string | undefined,
  ): AuthContext & { sessionId?: string; authVersion: number } {
    if (!authorizationHeader) {
      throw new AuthError('Missing Authorization header', 'MISSING_TOKEN');
    }

    const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      throw new AuthError('Authorization header must use the Bearer scheme', 'INVALID_TOKEN');
    }

    const claims = this.verify(token);
    return {
      tenantId: claims.tid,
      userId: claims.sub,
      role: claims.role,
      sessionId: claims.sid,
      authVersion: claims.ver ?? 0,
    };
  }

  /** A 10-minute token for the platform console (G1). */
  issuePlatform(input: { userId: string; sessionId: string; authVersion: number }): string {
    return issuePlatformToken({ ...input, ttlSeconds: 600 }, this.config);
  }

  /** The platform identity in a bearer header; organization tokens are refused. */
  authenticatePlatform(authorizationHeader: string | undefined): {
    userId: string;
    sessionId: string;
    authVersion: number;
  } {
    if (!authorizationHeader) {
      throw new AuthError('Missing Authorization header', 'MISSING_TOKEN');
    }
    const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      throw new AuthError('Authorization header must use the Bearer scheme', 'INVALID_TOKEN');
    }
    const claims = verifyPlatformToken(token, this.config);
    return { userId: claims.sub, sessionId: claims.sid, authVersion: claims.ver };
  }
}
