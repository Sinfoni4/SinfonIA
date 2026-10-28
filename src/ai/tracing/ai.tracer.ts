export const AI_TRACE_OUTCOMES = [
  'SUCCESS',
  'AMBIGUOUS',
  'REJECTED',
  'SECURITY_REJECTED',
  'ERROR',
  'LLM_DISABLED',
  'DETERMINISTIC_FALLBACK',
] as const;

export type AITraceOutcome = (typeof AI_TRACE_OUTCOMES)[number];

export type AITraceTokens = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type AITraceRecord = {
  requestId: string;
  tenantId: string;
  userId?: string | null;
  model: string;
  provider: string;
  tokens?: AITraceTokens;
  latencyMs: number;
  outcome: AITraceOutcome;
  action?: string | null;
  error?: string | null;
  timestamp: string;
};

export type AITraceQuery = {
  tenantId: string;
  outcome?: AITraceOutcome;
  from?: Date;
  to?: Date;
  /** 1-based page, most recent traces first. */
  page: number;
  limit: number;
};

/** Durable trace storage (PostgreSQL in production). */
export interface AITraceStore {
  save(trace: AITraceRecord): Promise<void>;
  query(filter: AITraceQuery): Promise<{ items: AITraceRecord[]; total: number }>;
}

/**
 * Records AI request traces. Recent traces stay in memory; with a store they are also persisted
 * (in the background: a storage failure never fails the user's request) and queried from it.
 */
export class AITracer {
  private readonly buffer: AITraceRecord[] = [];
  private readonly maxBufferSize: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    maxBufferSize = 200,
    private readonly options: {
      store?: AITraceStore;
      log?: { error: (obj: object, msg: string) => void };
    } = {},
  ) {
    this.maxBufferSize = maxBufferSize;
  }

  record(trace: AITraceRecord): AITraceRecord {
    this.buffer.push(trace);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
    const store = this.options.store;
    if (store) {
      const saving = store
        .save(trace)
        .catch((err: unknown) => {
          this.options.log?.error(
            { requestId: trace.requestId, error: err instanceof Error ? err.name : 'Error' },
            'AI trace not persisted',
          );
        })
        .finally(() => this.pending.delete(saving));
      this.pending.add(saving);
    }
    return trace;
  }

  /** Waits for the traces still being persisted (shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Paginated traces of a tenant, most recent first: from the store when there is one. */
  async queryTraces(filter: AITraceQuery): Promise<{ items: AITraceRecord[]; total: number }> {
    if (this.options.store) {
      return this.options.store.query(filter);
    }
    const matching = this.buffer
      .filter(
        (t) =>
          t.tenantId === filter.tenantId &&
          (!filter.outcome || t.outcome === filter.outcome) &&
          (!filter.from || new Date(t.timestamp) >= filter.from) &&
          (!filter.to || new Date(t.timestamp) <= filter.to),
      )
      .reverse();
    const start = (filter.page - 1) * filter.limit;
    return { items: matching.slice(start, start + filter.limit), total: matching.length };
  }

  getLastTrace(): AITraceRecord | undefined {
    return this.buffer[this.buffer.length - 1];
  }

  getTraces(filter?: {
    tenantId?: string;
    outcome?: AITraceOutcome;
    limit?: number;
  }): AITraceRecord[] {
    let result = [...this.buffer];
    if (filter?.tenantId) {
      result = result.filter((t) => t.tenantId === filter.tenantId);
    }
    if (filter?.outcome) {
      result = result.filter((t) => t.outcome === filter.outcome);
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }
    return result;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

export const defaultAITracer = new AITracer();
