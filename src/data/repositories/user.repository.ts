import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { UserDTO } from '../types/domain.js';
import type { PrismaLike } from '../types/prisma.js';
import type { UserRole } from '@prisma/client';

function toUserDTO(row: {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}): UserDTO {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class UserRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createUser(tenantId: string, data: { email: string; role?: UserRole }): Promise<UserDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.user.create({
        data: {
          tenantId,
          email: data.email,
          role: data.role ?? 'MEMBER',
        },
      });
      return toUserDTO(row);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create user', err);
    }
  }

  async getUserById(tenantId: string, id: string): Promise<UserDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.user.findFirst({
        where: { tenantId, id },
      });
      if (!row) throw new NotFoundError('User not found');
      return toUserDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to get user', err);
    }
  }

  async listUsers(tenantId: string): Promise<UserDTO[]> {
    requireTenantId(tenantId);
    try {
      const rows = await this.prisma.user.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toUserDTO);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list users', err);
    }
  }
}
