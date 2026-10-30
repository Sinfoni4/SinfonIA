import { Prisma } from '@prisma/client';

import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PracticeDTO } from '../types/domain.js';
import type { PrismaLike } from '../types/prisma.js';
import type { PracticeStatus } from '@prisma/client';

export type PracticeListFilter = {
  userId?: string;
  status?: PracticeStatus;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
};

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type PracticeRow = {
  id: string;
  tenantId: string;
  userId: string;
  status: PracticeStatus;
  version: number;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function toPracticeDTO(row: PracticeRow): PracticeDTO {
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
      const owner = await this.prisma.membership.findFirst({
        where: { orgId: tenantId, userId: data.userId, status: 'ACTIVE' },
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

  async listPractices(
    tenantId: string,
    filter?: { userId?: string; status?: PracticeStatus; search?: string; limit?: number },
  ): Promise<PracticeDTO[]> {
    requireTenantId(tenantId);
    try {
      const search = filter?.search?.trim();
      const isUuid =
        Boolean(search) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search!);

      const where: Prisma.PracticeWhereInput = {
        tenantId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(search
          ? isUuid
            ? {
                OR: [
                  { id: search },
                  {
                    payload: {
                      path: ['name'],
                      string_contains: search,
                      mode: 'insensitive',
                    },
                  },
                ],
              }
            : {
                payload: {
                  path: ['name'],
                  string_contains: search,
                  mode: 'insensitive',
                },
              }
          : {}),
      };

      const rows = await this.prisma.practice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...(filter?.limit ? { take: filter.limit } : {}),
      });
      return rows.map(toPracticeDTO);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list practices', err);
    }
  }

  /**
   * One batch of practices for an export, most recent first, after the given cursor. Only id,
   * name and creation date are read: payloads (which can hold OCR results) stay in the database.
   */
  async findExportBatch(
    tenantId: string,
    options: {
      userId?: string;
      from?: Date;
      to?: Date;
      after?: { createdAt: Date; id: string };
      take: number;
    },
  ): Promise<Array<{ id: string; name: string | null; createdAt: Date }>> {
    requireTenantId(tenantId);
    const conditions: Prisma.Sql[] = [Prisma.sql`"tenant_id" = ${tenantId}::uuid`];
    if (options.userId) conditions.push(Prisma.sql`"user_id" = ${options.userId}::uuid`);
    if (options.from) conditions.push(Prisma.sql`"created_at" >= ${options.from}`);
    if (options.to) conditions.push(Prisma.sql`"created_at" < ${options.to}`);
    if (options.after) {
      conditions.push(
        Prisma.sql`("created_at", "id") < (${options.after.createdAt}, ${options.after.id}::uuid)`,
      );
    }
    try {
      return await this.prisma.$queryRaw<
        Array<{ id: string; name: string | null; createdAt: Date }>
      >`
        SELECT "id", "payload"->>'name' AS "name", "created_at" AS "createdAt"
        FROM "practice"
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT ${options.take}`;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to read practices for export', err);
    }
  }

  async findPracticesPaginated(
    tenantId: string,
    filter?: PracticeListFilter,
  ): Promise<PaginatedResult<PracticeDTO>> {
    requireTenantId(tenantId);
    try {
      const page = Math.max(1, filter?.page ?? 1);
      const limit = Math.min(100, Math.max(1, filter?.limit ?? 20));
      const skip = (page - 1) * limit;
      const sortField = filter?.sortBy ?? 'createdAt';
      const sortOrder = filter?.sortOrder ?? 'desc';
      const search = filter?.search?.trim();
      const isUuid =
        Boolean(search) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search!);

      const where: Prisma.PracticeWhereInput = {
        tenantId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(search
          ? isUuid
            ? {
                OR: [
                  { id: search },
                  {
                    payload: {
                      path: ['name'],
                      string_contains: search,
                      mode: 'insensitive',
                    },
                  },
                ],
              }
            : {
                payload: {
                  path: ['name'],
                  string_contains: search,
                  mode: 'insensitive',
                },
              }
          : {}),
      };

      // Rows and total in one query (one connection instead of two in parallel): under concurrent
      // load the second connection made requests wait for the pool.
      const conditions: Prisma.Sql[] = [Prisma.sql`"tenant_id" = ${tenantId}::uuid`];
      if (filter?.userId) conditions.push(Prisma.sql`"user_id" = ${filter.userId}::uuid`);
      if (filter?.status) {
        conditions.push(Prisma.sql`"status" = ${filter.status}::"PracticeStatus"`);
      }
      if (search) {
        const byName = Prisma.sql`("payload"->>'name') ILIKE ${`%${search}%`}`;
        conditions.push(isUuid ? Prisma.sql`("id" = ${search}::uuid OR ${byName})` : byName);
      }
      const orderColumn = Prisma.raw(sortField === 'updatedAt' ? '"updated_at"' : '"created_at"');
      const orderDirection = Prisma.raw(sortOrder === 'asc' ? 'ASC' : 'DESC');
      const rows = await this.prisma.$queryRaw<Array<PracticeRow & { total: bigint }>>`
        SELECT "id", "tenant_id" AS "tenantId", "user_id" AS "userId", "status", "version",
               "payload", "created_at" AS "createdAt", "updated_at" AS "updatedAt",
               count(*) OVER () AS "total"
        FROM "practice"
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY ${orderColumn} ${orderDirection}
        OFFSET ${skip} LIMIT ${limit}`;
      // A page past the end has no rows to carry the total: count separately (rare).
      const total =
        rows.length > 0
          ? Number(rows[0].total)
          : skip > 0
            ? await this.prisma.practice.count({ where })
            : 0;

      return {
        items: rows.map(toPracticeDTO),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find paginated practices', err);
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

  async updatePracticePayload(
    tenantId: string,
    id: string,
    payload: unknown,
  ): Promise<PracticeDTO> {
    requireTenantId(tenantId);
    try {
      const res = await this.prisma.practice.updateMany({
        where: { tenantId, id },
        data: { payload: payload as never },
      });
      if (res.count !== 1) {
        throw new NotFoundError('Practice not found');
      }
      const row = await this.prisma.practice.findFirst({
        where: { tenantId, id },
      });
      if (!row) throw new NotFoundError('Practice not found');
      return toPracticeDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to update practice payload', err);
    }
  }
}
