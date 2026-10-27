export type AITraceOutcome =
  | 'SUCCESS'
  | 'AMBIGUOUS'
  | 'REJECTED'
  | 'SECURITY_REJECTED'
  | 'ERROR'
  | 'LLM_DISABLED'
  | 'DETERMINISTIC_FALLBACK';

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

export class AITracer {
  private readonly buffer: AITraceRecord[] = [];
  private readonly maxBufferSize: number;

  constructor(maxBufferSize = 200) {
    this.maxBufferSize = maxBufferSize;
  }

  record(trace: AITraceRecord): AITraceRecord {
    this.buffer.push(trace);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
    return trace;
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
