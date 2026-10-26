import { randomUUID } from 'node:crypto';

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
  telegramId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UserDTO {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    role: row.role,
    telegramId: row.telegramId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class UserRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createUser(
    tenantId: string,
    data: { email: string; role?: UserRole; telegramId?: string | null },
  ): Promise<UserDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.user.create({
        data: {
          tenantId,
          email: data.email,
          role: data.role ?? 'MEMBER',
          telegramId: data.telegramId ?? null,
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

  async ensureTelegramUser(tenantId: string, telegramId: string): Promise<UserDTO> {
    requireTenantId(tenantId);
    const normalizedTelegramId = telegramId.trim();
    if (!normalizedTelegramId) {
      throw new DatabaseError('telegramId is required');
    }

    try {
      const existing = await this.prisma.user.findFirst({
        where: { tenantId, telegramId: normalizedTelegramId },
      });
      if (existing) return toUserDTO(existing);

      const created = await this.prisma.user.create({
        data: {
          tenantId,
          telegramId: normalizedTelegramId,
          email: `telegram-${randomUUID()}@local.invalid`,
          role: 'MEMBER',
        },
      });
      return toUserDTO(created);
    } catch (err: unknown) {
      if (isUniqueConstraintError(err)) {
        const existing = await this.prisma.user.findFirst({
          where: { tenantId, telegramId: normalizedTelegramId },
        });
        if (existing) return toUserDTO(existing);
      }
      throw new DatabaseError('Failed to ensure Telegram user', err);
    }
  }

  async findByTelegramId(telegramId: string): Promise<UserDTO | null> {
    const normalized = telegramId.trim();
    if (!normalized) return null;
    try {
      const row = await this.prisma.user.findFirst({
        where: { telegramId: normalized },
        orderBy: { createdAt: 'desc' },
      });
      return row ? toUserDTO(row) : null;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find Telegram user', err);
    }
  }

  async findFirstAdmin(tenantId: string): Promise<UserDTO | null> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.user.findFirst({
        where: { tenantId, role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
      });
      return row ? toUserDTO(row) : null;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find tenant admin', err);
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

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
