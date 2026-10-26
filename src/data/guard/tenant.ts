export function requireTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new Error('tenantId is required');
  }
  return tenantId;
}
