import { AuditRepository } from '../repositories/audit.repository.js';

import type { PrismaLike } from '../types/prisma.js';

// Data-layer service: composes repositories without exposing Prisma outward.
// No business rules: only guarantees append-only audit persistence.
export class AuditService {
  private readonly repo: AuditRepository;

  constructor(prisma: PrismaLike) {
    this.repo = new AuditRepository(prisma);
  }

  async logEvent(input: {
    tenantId: string;
    userId: string | null;
    eventType: string;
    payload: unknown;
  }) {
    return this.repo.appendEvent(input);
  }
}
