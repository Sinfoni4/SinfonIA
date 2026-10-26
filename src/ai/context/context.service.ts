import { requireDatabase } from '../../runtime/runtime.guard.js';

import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';
import type { PracticeState } from '../../core/types/workflow.types.js';

export type PracticeContextItem = {
  id: string;
  name?: string | null;
  status: 'CREATED' | 'VALIDATED' | 'COMPLETED' | 'SUBMITTED' | 'FAILED';
  type: string;
  summary: string;
};

export type PracticeContext = {
  practices: PracticeContextItem[];
  totalCount?: number;
  page?: number;
  limit?: number;
};

export type PracticeContextOptions = {
  search?: string;
  status?: PracticeState;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
};

export class ContextService {
  constructor(
    private readonly practiceService: Pick<PracticeApplicationService, 'listPractices'> &
      Partial<Pick<PracticeApplicationService, 'listPracticesPaginated'>>,
  ) {}

  /**
   * Retrieves context practices strictly scoped to the tenant.
   * Supports search keywords, pagination, and sorting.
   */
  async getPracticeContext(
    tenantId: string,
    userId?: string | null,
    options?: PracticeContextOptions,
  ): Promise<PracticeContext> {
    requireDatabase();

    const limit = options?.limit ?? 20;

    // Use paginated retrieval if pagination or sorting was requested and service supports it
    if (
      (options?.page || options?.sortBy) &&
      typeof this.practiceService.listPracticesPaginated === 'function'
    ) {
      const sortBy =
        options?.sortBy === 'updated_at' || options?.sortBy === 'updatedAt'
          ? 'updatedAt'
          : options?.sortBy
            ? 'createdAt'
            : undefined;

      const paginated = await this.practiceService.listPracticesPaginated({
        tenantId,
        ...(userId ? { userId } : {}),
        page: options?.page ?? 1,
        limit,
        status: options?.status,
        search: options?.search,
        sortBy,
        sortOrder: options?.sortOrder,
      });

      return {
        practices: paginated.items.map((practice) => ({
          id: practice.id,
          name: practice.name,
          status: practice.status,
          type: practice.typeLabel,
          summary: practice.summary,
        })),
        totalCount: paginated.total,
        page: paginated.page,
        limit: paginated.limit,
      };
    }

    const practices = await this.practiceService.listPractices({
      tenantId,
      ...(userId ? { userId } : {}),
      status: options?.status,
      search: options?.search,
      limit,
    });

    return {
      practices: practices.map((practice) => ({
        id: practice.id,
        name: practice.name,
        status: practice.status,
        type: practice.typeLabel,
        summary: practice.summary,
      })),
      totalCount: practices.length,
      page: 1,
      limit,
    };
  }

  /**
   * Retrieves tenant-scoped practices relevant to a user query text.
   * Extracts UUIDs or quoted names automatically, with safe fallback to general tenant context.
   */
  async getRelevantPracticeContext(
    tenantId: string,
    queryText: string,
    userId?: string | null,
    limit = 20,
  ): Promise<PracticeContext> {
    const trimmed = queryText.trim();
    const uuidMatch = trimmed.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    const quotedMatch = trimmed.match(/["']([^"']+)["']/);

    const search = uuidMatch ? uuidMatch[0] : quotedMatch ? quotedMatch[1] : undefined;

    const ctx = await this.getPracticeContext(tenantId, userId, { search, limit });
    if (ctx.practices.length === 0 && search) {
      // Fallback to recent tenant practices so AI has context if specific name/uuid didn't match
      return this.getPracticeContext(tenantId, userId, { limit });
    }
    return ctx;
  }
}
