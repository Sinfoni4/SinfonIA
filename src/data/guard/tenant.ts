const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function requireTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !isUuid(tenantId.trim())) {
    throw new Error('tenantId must be a valid UUID');
  }
  return tenantId.trim();
}

export function requireUserId(userId: string): string {
  if (typeof userId !== 'string' || !isUuid(userId.trim())) {
    throw new Error('userId must be a valid UUID');
  }
  return userId.trim();
}
