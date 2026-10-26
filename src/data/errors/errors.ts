export class DatabaseError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DatabaseError';
    this.cause = cause;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// In this codebase, cross-tenant access should be impossible because queries always scope by tenantId.
// This error exists to support future checks where a caller provides (tenantId, id) pairs that don't match
// and we choose to distinguish it from "not found" (e.g., for internal security telemetry).
export class UnauthorizedTenantAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedTenantAccessError';
  }
}
