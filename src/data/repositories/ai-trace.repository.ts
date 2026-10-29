import { redactPIIForLogging } from '../../ai/security/pii-minimizer.js';
import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { AITraceRecord, AITraceStore, AITraceQuery } from '../../ai/tracing/ai.tracer.js';
import type { PrismaLike } from '../types/prisma.js';
import type { AiTrace } from '@prisma/client';

const MAX_ERROR_LENGTH = 500;

function toRecord(row: AiTrace): AITraceRecord {
  return {
    requestId: row.requestId,
    tenantId: row.tenantId,
    userId: row.userId,
    model: row.model,
    provider: row.provider,
    latencyMs: row.latencyMs,
    outcome: row.outcome as AITraceRecord['outcome'],
    action: row.action,
    error: row.error,
    timestamp: row.createdAt.toISOString(),
    ...(row.promptTokens !== null || row.completionTokens !== null || row.totalTokens !== null
      ? {
          tokens: {
            ...(row.promptTokens !== null ? { promptTokens: row.promptTokens } : {}),
            ...(row.completionTokens !== null ? { completionTokens: row.completionTokens } : {}),
            ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
          },
        }
      : {}),
  };
}

/** PostgreSQL store of AI traces: metadata only, never prompt or completion text. */
export class AiTraceRepository implements AITraceStore {
  constructor(private readonly prisma: PrismaLike) {}

  async save(trace: AITraceRecord): Promise<void> {
    requireTenantId(trace.tenantId);
    try {
      await this.prisma.aiTrace.create({
        data: {
          tenantId: trace.tenantId,
          userId: trace.userId ?? null,
          requestId: trace.requestId,
          model: trace.model,
          provider: trace.provider,
          outcome: trace.outcome,
          action: trace.action ?? null,
          latencyMs: Math.max(0, Math.round(trace.latencyMs)),
          promptTokens: trace.tokens?.promptTokens ?? null,
          completionTokens: trace.tokens?.completionTokens ?? null,
          totalTokens: trace.tokens?.totalTokens ?? null,
          // Error messages may quote user input: redacted and truncated before storage.
          error: trace.error ? redactPIIForLogging(trace.error).slice(0, MAX_ERROR_LENGTH) : null,
          createdAt: new Date(trace.timestamp),
        },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to save AI trace', err);
    }
  }

  async query(filter: AITraceQuery): Promise<{ items: AITraceRecord[]; total: number }> {
    requireTenantId(filter.tenantId);
    const where = {
      tenantId: filter.tenantId,
      ...(filter.outcome ? { outcome: filter.outcome } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    };
    try {
      const [rows, total] = await Promise.all([
        this.prisma.aiTrace.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (filter.page - 1) * filter.limit,
          take: filter.limit,
        }),
        this.prisma.aiTrace.count({ where }),
      ]);
      return { items: rows.map(toRecord), total };
    } catch (err: unknown) {
      throw new DatabaseError('Failed to query AI traces', err);
    }
  }

  /** Retention: deletes traces older than `cutoff` across tenants. */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    try {
      const { count } = await this.prisma.aiTrace.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      return count;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to delete old AI traces', err);
    }
  }
}
