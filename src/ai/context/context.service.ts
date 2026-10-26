import { requireDatabase } from '../../runtime/runtime.guard.js';

import type { PracticeApplicationService } from '../../core/practice/practice.application.service.js';

export type PracticeContext = {
  practices: Array<{
    id: string;
    name?: string | null;
    status: 'CREATED' | 'VALIDATED' | 'COMPLETED' | 'SUBMITTED' | 'FAILED';
    type: string;
    summary: string;
  }>;
};

export class ContextService {
  constructor(
    private readonly practiceService: Pick<PracticeApplicationService, 'listPractices'>,
  ) {}

  async getPracticeContext(tenantId: string, userId?: string | null): Promise<PracticeContext> {
    requireDatabase();

    const practices = await this.practiceService.listPractices({
      tenantId,
      ...(userId ? { userId } : {}),
      limit: 20,
    });

    return {
      practices: practices.map((practice) => ({
        id: practice.id,
        name: practice.name,
        status: practice.status,
        type: practice.typeLabel,
        summary: practice.summary,
      })),
    };
  }
}
