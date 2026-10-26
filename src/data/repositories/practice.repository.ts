import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PracticeDTO } from '../types/domain.js';
import type { PrismaLike } from '../types/prisma.js';
import type { PracticeStatus } from '@prisma/client';

function toPracticeDTO(row: {
  id: string;
  tenantId: string;
  userId: string;
  status: PracticeStatus;
  version: number;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}): PracticeDTO {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    status: row.status,
    version: row.version,
    payload: row.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PracticeRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createPractice(
    tenantId: string,
    data: { userId: string; status?: PracticeStatus; payload: unknown },
  ): Promise<PracticeDTO> {
    requireTenantId(tenantId);
    try {
      const owner = await this.prisma.user.findFirst({
        where: { tenantId, id: data.userId },
        select: { id: true },
      });
      if (!owner) {
        throw new NotFoundError('User not found in tenant');
      }

      const row = await this.prisma.practice.create({
        data: {
          tenantId,
          userId: data.userId,
          status: data.status ?? 'CREATED',
          payload: data.payload as never,
        },
      });
      return toPracticeDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to create practice', err);
    }
  }

  async getPracticeById(tenantId: string, id: string): Promise<PracticeDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.practice.findFirst({
        where: { tenantId, id },
      });
      if (!row) throw new NotFoundError('Practice not found');
      return toPracticeDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to get practice', err);
    }
  }

  async listPractices(tenantId: string, filter?: { userId?: string; status?: PracticeStatus }) {
    requireTenantId(tenantId);
    try {
      const rows = await this.prisma.practice.findMany({
        where: {
          tenantId,
          ...(filter?.userId ? { userId: filter.userId } : {}),
          ...(filter?.status ? { status: filter.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toPracticeDTO);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list practices', err);
    }
  }

  async updatePracticeStatus(
    tenantId: string,
    id: string,
    nextStatus: PracticeStatus,
  ): Promise<PracticeDTO> {
    requireTenantId(tenantId);
    try {
      const res = await this.prisma.practice.updateMany({
        where: { tenantId, id },
        data: { status: nextStatus },
      });
      if (res.count !== 1) {
        throw new NotFoundError('Practice not found');
      }
      // Re-read inside the same transaction context (tx or client).
      const row = await this.prisma.practice.findFirst({ where: { tenantId, id } });
      if (!row) throw new NotFoundError('Practice not found');
      return toPracticeDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to update practice status', err);
    }
  }

  async updatePracticeStatusWithVersion(input: {
    tenantId: string;
    id: string;
    nextStatus: PracticeStatus;
    currentVersion: number;
  }): Promise<PracticeDTO> {
    requireTenantId(input.tenantId);
    try {
      const res = await this.prisma.practice.updateMany({
        where: { tenantId: input.tenantId, id: input.id, version: input.currentVersion },
        data: { status: input.nextStatus, version: { increment: 1 } },
      });
      if (res.count !== 1) {
        // caller distinguishes this case as concurrency conflict
        throw new NotFoundError('Practice not found or version mismatch');
      }
      const row = await this.prisma.practice.findFirst({
        where: { tenantId: input.tenantId, id: input.id },
      });
      if (!row) throw new NotFoundError('Practice not found');
      return toPracticeDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to update practice status with version', err);
    }
  }

  async deletePracticeById(tenantId: string, id: string): Promise<void> {
    requireTenantId(tenantId);
    try {
      const res = await this.prisma.practice.deleteMany({ where: { tenantId, id } });
      if (res.count !== 1) {
        throw new NotFoundError('Practice not found');
      }
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to delete practice', err);
    }
  }
}
