import { AuthError } from './auth.errors.js';
import { issueAuthToken, verifyAuthToken } from './token.js';

import type { AuthClaims, AuthConfig, AuthContext } from './auth.types.js';

export class AuthService {
  constructor(private readonly config: AuthConfig) {}

  issue(input: {
    tenantId: string;
    userId: string;
    role: AuthClaims['role'];
    ttlSeconds?: number;
  }): string {
    return issueAuthToken(input, this.config);
  }

  verify(token: string): AuthClaims {
    return verifyAuthToken(token, this.config);
  }

  authenticate(authorizationHeader: string | undefined): AuthContext {
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
    };
  }
}
