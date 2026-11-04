import { runtimeState } from '../../runtime/runtime.state.js';

import type { PrismaClient } from '@prisma/client';

/**
 * A5 / FE8 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §5): the state of the system and the use of
 * the AI, for the platform console. Technical data and counts only: never contents of
 * organizations, messages, prompts or error texts.
 */

/** Which external services this process is configured for (never the secrets). */
export type ConfiguredServices = {
  telegram: boolean;
  whatsapp: boolean;
  webhook: boolean;
  /** The AI provider when the AI is on, otherwise null. */
  ai: string | null;
};

export type SystemHealth = {
  checkedAt: Date;
  database: { reachable: boolean; latencyMs: number | null; mode: string };
  process: { uptimeSeconds: number; memoryMb: number; node: string };
  outbox: {
    pending: number;
    processing: number;
    failed: number;
    deadLetter: number;
    /** Minutes the oldest message still to deliver has been waiting. */
    oldestPendingMinutes: number | null;
    deadLetterLast24h: number;
  };
  scheduler: { lastRunAt: Date | null; failedLast24h: number; runsLast24h: number };
  services: ConfiguredServices;
};

const DAY_MS = 24 * 60 * 60_000;

export async function systemHealth(
  prisma: PrismaClient,
  services: ConfiguredServices,
): Promise<SystemHealth> {
  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS);
  let latencyMs: number | null = null;
  let reachable = false;
  const started = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    latencyMs = Math.round(performance.now() - started);
    reachable = true;
  } catch {
    reachable = false;
  }
  const empty: SystemHealth['outbox'] = {
    pending: 0,
    processing: 0,
    failed: 0,
    deadLetter: 0,
    oldestPendingMinutes: null,
    deadLetterLast24h: 0,
  };
  let outbox = empty;
  let scheduler: SystemHealth['scheduler'] = { lastRunAt: null, failedLast24h: 0, runsLast24h: 0 };
  if (reachable) {
    const [byStatus, oldest, deadRecent, lastRun, runs, failedRuns] = await Promise.all([
      prisma.outboxMessage.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.outboxMessage.findFirst({
        where: { status: { in: ['PENDING', 'FAILED'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.outboxMessage.count({
        where: { status: 'DEAD_LETTER', updatedAt: { gte: since } },
      }),
      prisma.schedulerRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      prisma.schedulerRun.count({ where: { startedAt: { gte: since } } }),
      prisma.schedulerRun.count({ where: { startedAt: { gte: since }, status: 'FAILED' } }),
    ]);
    const count = (status: string) => byStatus.find((g) => g.status === status)?._count._all ?? 0;
    outbox = {
      pending: count('PENDING'),
      processing: count('PROCESSING'),
      failed: count('FAILED'),
      deadLetter: count('DEAD_LETTER'),
      oldestPendingMinutes: oldest
        ? Math.floor((now.getTime() - oldest.createdAt.getTime()) / 60_000)
        : null,
      deadLetterLast24h: deadRecent,
    };
    scheduler = {
      lastRunAt: lastRun?.startedAt ?? null,
      failedLast24h: failedRuns,
      runsLast24h: runs,
    };
  }
  return {
    checkedAt: now,
    database: { reachable, latencyMs, mode: runtimeState.getMode() },
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      node: process.version,
    },
    outbox,
    scheduler,
    services,
  };
}

export type AiUsage = {
  days: number;
  totals: {
    requests: number;
    errors: number;
    tokens: number;
    averageLatencyMs: number | null;
  };
  byOutcome: Array<{ outcome: string; requests: number }>;
  byDay: Array<{ day: string; requests: number; tokens: number; errors: number }>;
  byModel: Array<{ provider: string; model: string; requests: number; tokens: number }>;
  byOrganization: Array<{
    orgId: string;
    name: string;
    requests: number;
    tokens: number;
    errors: number;
  }>;
};

/** Outcomes that mean the AI could not do its job (not a refusal of a request). */
const ERROR_OUTCOMES = ['ERROR', 'LLM_DISABLED'];

/**
 * Use of the AI over the last `days` days, from the traces (ai_trace): volumes, tokens, latency,
 * by day, model and organization. The traces keep no prompt or answer; their error text is not
 * shown here either.
 */
export async function aiUsage(prisma: PrismaClient, days: number): Promise<AiUsage> {
  const since = new Date(Date.now() - days * DAY_MS);
  const where = { createdAt: { gte: since } };
  const [totals, byOutcome, byModel, byTenant, byDay] = await Promise.all([
    prisma.aiTrace.aggregate({
      where,
      _count: { _all: true },
      _sum: { totalTokens: true },
      _avg: { latencyMs: true },
    }),
    prisma.aiTrace.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
    prisma.aiTrace.groupBy({
      by: ['provider', 'model'],
      where,
      _count: { _all: true },
      _sum: { totalTokens: true },
    }),
    prisma.aiTrace.groupBy({
      by: ['tenantId'],
      where,
      _count: { _all: true },
      _sum: { totalTokens: true },
    }),
    prisma.$queryRaw<Array<{ day: string; requests: bigint; tokens: bigint; errors: bigint }>>`
      SELECT to_char(date_trunc('day', "created_at" AT TIME ZONE 'Europe/Rome'), 'YYYY-MM-DD') AS "day",
             count(*) AS "requests",
             coalesce(sum("total_tokens"), 0) AS "tokens",
             count(*) FILTER (WHERE "outcome" IN ('ERROR', 'LLM_DISABLED')) AS "errors"
      FROM "ai_trace"
      WHERE "created_at" >= ${since}
      GROUP BY 1
      ORDER BY 1`,
  ]);
  const errorsByTenant = await prisma.aiTrace.groupBy({
    by: ['tenantId'],
    where: { ...where, outcome: { in: ERROR_OUTCOMES } },
    _count: { _all: true },
  });
  const tenants = byTenant.length
    ? await prisma.tenant.findMany({
        where: { id: { in: byTenant.map((t) => t.tenantId) } },
        select: { id: true, name: true },
      })
    : [];
  const errors = byOutcome
    .filter((o) => ERROR_OUTCOMES.includes(o.outcome))
    .reduce((sum, o) => sum + o._count._all, 0);
  return {
    days,
    totals: {
      requests: totals._count._all,
      errors,
      tokens: totals._sum.totalTokens ?? 0,
      averageLatencyMs: totals._avg.latencyMs === null ? null : Math.round(totals._avg.latencyMs),
    },
    byOutcome: byOutcome
      .map((o) => ({ outcome: o.outcome, requests: o._count._all }))
      .sort((a, b) => b.requests - a.requests),
    byDay: byDay.map((d) => ({
      day: d.day,
      requests: Number(d.requests),
      tokens: Number(d.tokens),
      errors: Number(d.errors),
    })),
    byModel: byModel
      .map((m) => ({
        provider: m.provider,
        model: m.model,
        requests: m._count._all,
        tokens: m._sum.totalTokens ?? 0,
      }))
      .sort((a, b) => b.requests - a.requests),
    byOrganization: byTenant
      .map((t) => ({
        orgId: t.tenantId,
        name: tenants.find((x) => x.id === t.tenantId)?.name ?? 'organizzazione eliminata',
        requests: t._count._all,
        tokens: t._sum.totalTokens ?? 0,
        errors: errorsByTenant.find((e) => e.tenantId === t.tenantId)?._count._all ?? 0,
      }))
      .sort((a, b) => b.requests - a.requests),
  };
}
