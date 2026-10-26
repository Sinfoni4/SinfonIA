export type AuthErrorCode =
  'MISSING_TOKEN' | 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'FORBIDDEN' | 'TENANT_MISMATCH';

export class AuthError extends Error {
  readonly statusCode: number;

  constructor(
    message: string,
    readonly code: AuthErrorCode,
    statusCode = 401,
  ) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}
