import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { TenantDTO } from '../types/domain.js';
import type { PrismaLike } from '../types/prisma.js';

function toTenantDTO(row: {
  id: string;
  name: string;
  module: string;
  integrationType: string;
  schedulerEnabled: boolean;
  schedulerFrequency: string | null;
  schedulerTasks: unknown;
  createdAt: Date;
  updatedAt: Date;
}): TenantDTO {
  return {
    id: row.id,
    name: row.name,
    module: row.module,
    integrationType: row.integrationType,
    schedulerEnabled: row.schedulerEnabled,
    schedulerFrequency: row.schedulerFrequency,
    schedulerTasks: row.schedulerTasks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TenantRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createTenant(data: {
    name: string;
    module?: string;
    integrationType?: string;
    schedulerEnabled?: boolean;
    schedulerFrequency?: string | null;
    schedulerTasks?: unknown;
  }): Promise<TenantDTO> {
    try {
      const row = await this.prisma.tenant.create({
        data: {
          name: data.name,
          module: data.module ?? 'music',
          integrationType: data.integrationType ?? 'none',
          schedulerEnabled: data.schedulerEnabled ?? false,
          schedulerFrequency: data.schedulerFrequency ?? null,
          schedulerTasks: (data.schedulerTasks ?? null) as never,
        },
      });
      return toTenantDTO(row);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create tenant', err);
    }
  }

  async listTenants(): Promise<TenantDTO[]> {
    try {
      const rows = await this.prisma.tenant.findMany({
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTenantDTO);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list tenants', err);
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
