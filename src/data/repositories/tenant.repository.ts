import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { TenantDTO } from '../types/domain.js';
import type { PrismaLike } from '../types/prisma.js';

function toTenantDTO(row: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}): TenantDTO {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TenantRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createTenant(data: { name: string }): Promise<TenantDTO> {
    try {
      const row = await this.prisma.tenant.create({
        data: { name: data.name },
      });
      return toTenantDTO(row);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create tenant', err);
    }
  }

  async getTenantById(tenantId: string): Promise<TenantDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!row) throw new NotFoundError('Tenant not found');
      return toTenantDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to get tenant', err);
    }
  }
}
