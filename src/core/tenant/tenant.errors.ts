export class TenantNotLinkedError extends Error {
  constructor(message = 'Telegram account is not linked to a tenant') {
    super(message);
    this.name = 'TenantNotLinkedError';
  }
}

export class TenantNotFoundError extends Error {
  constructor(message = 'Tenant not found') {
    super(message);
    this.name = 'TenantNotFoundError';
  }
}
