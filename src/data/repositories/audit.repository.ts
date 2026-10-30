import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { AuditLogDTO } from '../types/domain.js';
import type { PrismaLike } from '../types/prisma.js';

function toAuditDTO(row: {
  id: string;
  tenantId: string;
  userId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}): AuditLogDTO {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    eventType: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class AuditRepository {
  constructor(private readonly prisma: PrismaLike) {}

  // Append-only: no update/delete methods exist by design.
  async appendEvent(input: {
    tenantId: string;
    userId: string | null;
    eventType: string;
    payload: unknown;
  }): Promise<AuditLogDTO> {
    requireTenantId(input.tenantId);
    try {
      if (input.userId) {
        // Any membership, even revoked: actions of a member are recorded after a revocation too.
        const owner = await this.prisma.membership.findFirst({
          where: { orgId: input.tenantId, userId: input.userId },
          select: { id: true },
        });
        if (!owner) {
          throw new NotFoundError('User not found in tenant');
        }
      }

      const row = await this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId ?? null,
          eventType: input.eventType,
          payload: input.payload as never,
        },
      });
      return toAuditDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to append audit event', err);
    }
  }

  async listByTenant(tenantId: string, opts?: { limit?: number }) {
    requireTenantId(tenantId);
    try {
      const rows = await this.prisma.auditLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: opts?.limit ?? 100,
      });
      return rows.map(toAuditDTO);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list audit events', err);
    }
  }
}
