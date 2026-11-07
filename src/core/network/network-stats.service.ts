import { Prisma } from '@prisma/client';

import { AuditService } from '../../data/services/audit.service.js';

import { NETWORK_TYPES, NetworkError } from './network.service.js';

import type { ComplianceCategory, PracticeStatus, PrismaClient, UsageKind } from '@prisma/client';

/**
 * MF9 statistics of a network (decision D4, docs/PROPOSTA_DECISIONI_D3_D4.md): only the closed
 * list of indicators I2–I7, computed on the server for fixed periods.
 *
 * Protection rules:
 * - D4.1: a value is shown only when it comes from at least MIN_COMPANIES member companies
 *   (`null` = «non disponibile»); with fewer members in the period nothing is shown;
 * - D4.2: counts of companies of 1 or 2 are shown as «meno di 3» (`'lt3'`);
 * - D4.3: fixed periods and categories, no free filter;
 * - D4.5: a company that leaves counts until the end of the period in which it left;
 * - D4.6: every consultation is recorded in the log of the network.
 */

export const MIN_COMPANIES = 5;

/** A protected value: a number, «meno di 3», or not available (`null`). */
export type Protected = number | 'lt3' | null;

export type StatsPeriodKind = 'month' | 'quarter' | 'year';

export type NetworkStats = {
  period: { kind: StatsPeriodKind; previous: boolean; from: string; to: string };
  members: { inPeriod: number; activeNow: number; threshold: number; sufficient: boolean };
  /** I2: practices opened in the period, by current state and by type. */
  practicesByStatus: Array<{ status: PracticeStatus; value: Protected }>;
  practicesByKind: Array<{ kind: string; value: Protected }>;
  /** I3: average days from opening to completion of the practices completed in the period. */
  completionDays: Array<{ kind: string; value: Protected }>;
  /** I4: member companies with at least one overdue deadline, or one due within 30 days. */
  deadlines: Array<{ category: ComplianceCategory; overdue: Protected; dueSoon: Protected }>;
  /** I5: member companies with a valid organic certification (open, not expired). */
  organic: { valid: Protected; total: number | null };
  /** I6: documents uploaded in the period and the share read without needing a check. */
  documents: { uploaded: Protected; readWithoutCheckPercent: Protected };
  /** I7: requests to the assistant in chat and accesses to the dashboard in the period. */
  channels: { chatRequests: Protected; dashboardLogins: Protected };
  /**
   * AGX-07: usage of the member companies in the period, by kind, under the same rules (D4.1):
   * a total is shown only when at least MIN_COMPANIES companies contribute to it.
   */
  usage: Array<{ kind: UsageKind; value: Protected }>;
  /**
   * AGX-07: the work the network itself did for its companies through delegations, by kind. It is
   * the network's own activity, so it is always shown, but never company by company.
   */
  delegatedWork: Array<{ kind: UsageKind; quantity: number }>;
};

const STATES: PracticeStatus[] = ['CREATED', 'VALIDATED', 'SUBMITTED', 'COMPLETED', 'FAILED'];
const CATEGORIES: ComplianceCategory[] = [
  'DURC',
  'SICUREZZA_LAVORO',
  'CERTIFICAZIONE_BIO',
  'VISITA_MEDICA',
  'PATENTINO',
  'ALTRO',
];
const DAY_MS = 24 * 60 * 60_000;
/** AGX-07: the usage a network sees; AI tokens stay a technical detail of the platform. */
const NETWORK_USAGE_KINDS: UsageKind[] = [
  'DOCUMENT_RECEIVED',
  'OCR_PAGES',
  'AI_CALL',
  'PRACTICE_OPENED',
  'PRACTICE_COMPLETED',
  'DOCUMENT_REQUESTED',
  'ASSISTANCE_CLOSED',
];

/** Start and end (exclusive) of a fixed period, in calendar terms of Europe/Rome (UTC dates). */
export function periodBounds(
  kind: StatsPeriodKind,
  previous: boolean,
  now = new Date(),
): { from: Date; to: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const shift = previous ? 1 : 0;
  if (kind === 'month') {
    return {
      from: new Date(Date.UTC(y, m - shift, 1)),
      to: new Date(Date.UTC(y, m - shift + 1, 1)),
    };
  }
  if (kind === 'quarter') {
    const q = Math.floor(m / 3) - shift;
    return { from: new Date(Date.UTC(y, q * 3, 1)), to: new Date(Date.UTC(y, q * 3 + 3, 1)) };
  }
  return { from: new Date(Date.UTC(y - shift, 0, 1)), to: new Date(Date.UTC(y - shift + 1, 0, 1)) };
}

/** D4.1: an amount is shown only when at least MIN_COMPANIES companies contribute to it. */
export function protectAmount(amount: number, contributors: number): Protected {
  if (contributors === 0) return 0;
  return contributors >= MIN_COMPANIES ? amount : null;
}

/** D4.2: a number of companies; 1 or 2 become «meno di 3». */
export function protectCompanies(companies: number): Protected {
  return companies > 0 && companies < 3 ? 'lt3' : companies;
}

type Row = { tenant_id: string; key: string; amount: number };

/** Sums by key and counts the companies behind each key. */
function byKey(rows: Row[]): Map<string, { amount: number; companies: Set<string> }> {
  const out = new Map<string, { amount: number; companies: Set<string> }>();
  for (const r of rows) {
    const entry = out.get(r.key) ?? { amount: 0, companies: new Set<string>() };
    entry.amount += Number(r.amount);
    if (Number(r.amount) > 0) entry.companies.add(r.tenant_id);
    out.set(r.key, entry);
  }
  return out;
}

export async function networkStats(
  prisma: PrismaClient,
  input: {
    networkId: string;
    actorUserId: string;
    kind: StatsPeriodKind;
    previous: boolean;
    now?: Date;
  },
): Promise<NetworkStats> {
  const network = await prisma.tenant.findUnique({
    where: { id: input.networkId },
    select: { type: true },
  });
  if (!network || !NETWORK_TYPES.includes(network.type)) {
    throw new NetworkError(
      'Funzione disponibile solo per reti, consorzi e associazioni',
      403,
      'NOT_A_NETWORK',
    );
  }
  const now = input.now ?? new Date();
  const { from, to } = periodBounds(input.kind, input.previous, now);

  // D4.5: members in the period, including those who left during it; active organizations only.
  const relations = await prisma.organizationRelation.findMany({
    where: {
      parentOrgId: input.networkId,
      relationType: 'MEMBER_OF',
      refused: false,
      startedAt: { not: null, lt: to },
      OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      child: { status: 'ACTIVE' },
    },
    select: { childOrgId: true, status: true },
  });
  const inPeriod = [...new Set(relations.map((r) => r.childOrgId))];
  const activeNow = [
    ...new Set(relations.filter((r) => r.status === 'ACTIVE').map((r) => r.childOrgId)),
  ];
  const sufficient = inPeriod.length >= MIN_COMPANIES;
  const currentSufficient = activeNow.length >= MIN_COMPANIES;

  const result: NetworkStats = {
    period: {
      kind: input.kind,
      previous: input.previous,
      from: from.toISOString().slice(0, 10),
      to: new Date(to.getTime() - DAY_MS).toISOString().slice(0, 10),
    },
    members: {
      inPeriod: inPeriod.length,
      activeNow: activeNow.length,
      threshold: MIN_COMPANIES,
      sufficient,
    },
    practicesByStatus: STATES.map((status) => ({ status, value: null })),
    practicesByKind: [],
    completionDays: [],
    deadlines: CATEGORIES.map((category) => ({ category, overdue: null, dueSoon: null })),
    organic: { valid: null, total: null },
    documents: { uploaded: null, readWithoutCheckPercent: null },
    channels: { chatRequests: null, dashboardLogins: null },
    usage: NETWORK_USAGE_KINDS.map((kind) => ({ kind, value: null })),
    delegatedWork: [],
  };

  const delegated = await prisma.usageEvent.groupBy({
    by: ['kind'],
    where: { actorOrgId: input.networkId, occurredAt: { gte: from, lt: to } },
    _sum: { quantity: true },
  });
  result.delegatedWork = NETWORK_USAGE_KINDS.map((kind) => ({
    kind,
    quantity: delegated.find((d) => d.kind === kind)?._sum.quantity ?? 0,
  })).filter((d) => d.quantity !== 0);

  if (sufficient) {
    const ids = Prisma.join(inPeriod.map((id) => Prisma.sql`${id}::uuid`));
    const [byStatus, byKind, completion, docs, chat, logins, usage] = await Promise.all([
      prisma.$queryRaw<Row[]>`
        SELECT "tenant_id", "status"::text AS "key", count(*)::int AS "amount"
        FROM "practice"
        WHERE "tenant_id" IN (${ids}) AND "created_at" >= ${from} AND "created_at" < ${to}
        GROUP BY 1, 2`,
      prisma.$queryRaw<Row[]>`
        SELECT "tenant_id", coalesce("payload"->>'kind', 'generic') AS "key", count(*)::int AS "amount"
        FROM "practice"
        WHERE "tenant_id" IN (${ids}) AND "created_at" >= ${from} AND "created_at" < ${to}
        GROUP BY 1, 2`,
      // I3: the time to completion, approximated by the last update of a completed practice.
      prisma.$queryRaw<Array<{ tenant_id: string; key: string; days: number; n: number }>>`
        SELECT "tenant_id", coalesce("payload"->>'kind', 'generic') AS "key",
               sum(extract(epoch FROM ("updated_at" - "created_at")) / 86400)::float AS "days",
               count(*)::int AS "n"
        FROM "practice"
        WHERE "tenant_id" IN (${ids}) AND "status" = 'COMPLETED'
          AND "updated_at" >= ${from} AND "updated_at" < ${to}
        GROUP BY 1, 2`,
      prisma.$queryRaw<Array<{ tenant_id: string; total: number; clean: number }>>`
        SELECT "tenant_id", count(*)::int AS "total",
               count(*) FILTER (
                 WHERE "ocr_status" = 'COMPLETED'
                   AND coalesce(("ocr_result"->>'reviewRequired')::boolean, false) = false
               )::int AS "clean"
        FROM "practice_attachment"
        WHERE "tenant_id" IN (${ids}) AND "created_at" >= ${from} AND "created_at" < ${to}
        GROUP BY 1`,
      prisma.aiTrace.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: inPeriod }, createdAt: { gte: from, lt: to } },
        _count: { _all: true },
      }),
      prisma.auditLog.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: inPeriod },
          eventType: 'LOGIN_SUCCEEDED',
          createdAt: { gte: from, lt: to },
        },
        _count: { _all: true },
      }),
      prisma.usageEvent.groupBy({
        by: ['tenantId', 'kind'],
        where: { tenantId: { in: inPeriod }, occurredAt: { gte: from, lt: to } },
        _sum: { quantity: true },
      }),
    ]);

    const statusSums = byKey(byStatus);
    result.practicesByStatus = STATES.map((status) => {
      const s = statusSums.get(status);
      return { status, value: s ? protectAmount(s.amount, s.companies.size) : 0 };
    });
    const kindSums = byKey(byKind);
    result.practicesByKind = [...kindSums.entries()]
      .map(([kind, s]) => ({ kind, value: protectAmount(s.amount, s.companies.size) }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    const completionByKind = new Map<string, { days: number; n: number; companies: Set<string> }>();
    for (const r of completion) {
      const entry = completionByKind.get(r.key) ?? { days: 0, n: 0, companies: new Set<string>() };
      entry.days += Number(r.days);
      entry.n += Number(r.n);
      entry.companies.add(r.tenant_id);
      completionByKind.set(r.key, entry);
    }
    result.completionDays = [...completionByKind.entries()]
      .map(([kind, c]) => ({
        kind,
        value: protectAmount(Math.round((c.days / c.n) * 10) / 10, c.companies.size),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    const docTotal = docs.reduce((sum, d) => sum + Number(d.total), 0);
    const docClean = docs.reduce((sum, d) => sum + Number(d.clean), 0);
    const docCompanies = docs.filter((d) => Number(d.total) > 0).length;
    result.documents = {
      uploaded: protectAmount(docTotal, docCompanies),
      readWithoutCheckPercent:
        docTotal === 0
          ? null
          : protectAmount(Math.round((docClean / docTotal) * 100), docCompanies),
    };
    result.channels = {
      chatRequests: protectAmount(
        chat.reduce((sum, c) => sum + c._count._all, 0),
        chat.length,
      ),
      dashboardLogins: protectAmount(
        logins.reduce((sum, c) => sum + c._count._all, 0),
        logins.length,
      ),
    };
    const usageSums = byKey(
      usage.map((u) => ({ tenant_id: u.tenantId, key: u.kind, amount: u._sum.quantity ?? 0 })),
    );
    result.usage = NETWORK_USAGE_KINDS.map((kind) => {
      const u = usageSums.get(kind);
      return { kind, value: u ? protectAmount(u.amount, u.companies.size) : 0 };
    });
  }

  // I4 and I5 describe the situation today, so they use the companies that are members now.
  if (currentSufficient) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const soon = new Date(today.getTime() + 30 * DAY_MS);
    const open = await prisma.complianceDeadline.findMany({
      where: { tenantId: { in: activeNow }, status: 'OPEN' },
      select: { tenantId: true, category: true, dueDate: true },
    });
    result.deadlines = CATEGORIES.map((category) => {
      const overdue = new Set<string>();
      const dueSoon = new Set<string>();
      for (const d of open) {
        if (d.category !== category) continue;
        if (d.dueDate < today) overdue.add(d.tenantId);
        else if (d.dueDate <= soon) dueSoon.add(d.tenantId);
      }
      return {
        category,
        overdue: protectCompanies(overdue.size),
        dueSoon: protectCompanies(dueSoon.size),
      };
    });
    const organic = new Set(
      open
        .filter((d) => d.category === 'CERTIFICAZIONE_BIO' && d.dueDate >= today)
        .map((d) => d.tenantId),
    );
    result.organic = { valid: protectCompanies(organic.size), total: activeNow.length };
  }

  // D4.6: every consultation is recorded, with the period only.
  await new AuditService(prisma).logEvent({
    tenantId: input.networkId,
    userId: input.actorUserId,
    eventType: 'NETWORK_STATS_VIEWED',
    payload: { period: `${input.kind}${input.previous ? ':previous' : ''}` },
  });
  return result;
}
