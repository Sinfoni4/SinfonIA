import { personPracticesWhere } from '../../data/repositories/practice.repository.js';
import { parseIsoDate, todayInRome } from '../compliance/compliance.dates.js';
import { readPracticePayload } from '../practice/practice.payload.js';

import type { ComplianceService } from '../compliance/compliance.service.js';
import type { PracticeStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * The numbers of the dashboard home (P11, docs/PROGETTO_FRONTEND_V2.md §3, G7): practices by
 * state, open deadlines due within 30 days or overdue, documents to check, latest practices.
 * Counts and names only, always within the caller's scope: `practiceUserId` and `deadlineUserId`
 * come from the grants (set for own-scoped callers, absent for the whole organization).
 */

export const DEADLINE_HORIZON_DAYS = 30;
/** Days of the activity chart of the home: practices opened and documents received per day. */
export const ACTIVITY_DAYS = 90;
const DAY_MS = 86_400_000;
const LIST_SIZE = 5;

const STATES: PracticeStatus[] = ['CREATED', 'VALIDATED', 'SUBMITTED', 'FAILED', 'COMPLETED'];

export type DashboardSummary = {
  practices: { total: number; byStatus: Record<PracticeStatus, number> };
  deadlines: {
    overdue: number;
    dueSoon: number;
    upcoming: Array<{
      id: string;
      title: string;
      category: string;
      dueDate: string;
      daysLeft: number;
      /** Fase 1B: information-only deadlines are listed but not counted. */
      certainty: 'CONFIRMED' | 'TO_VERIFY' | 'INFORMATIONAL';
    }>;
  };
  documents: {
    toReview: number;
    unreadable: number;
    items: Array<{
      attachmentId: string;
      practiceId: string;
      practiceName: string;
      fileName: string;
      reason: 'review' | 'unreadable';
    }>;
  };
  recentPractices: Array<{ id: string; name: string; status: PracticeStatus; updatedAt: Date }>;
  /** One entry per day (Italian calendar), oldest first, the last one today; zeros included. */
  activity: Array<{ date: string; practices: number; documents: number }>;
};

/** The last `ACTIVITY_DAYS` days, in Italy, as YYYY-MM-DD, oldest first. */
function activityDays(now: Date): string[] {
  const today = parseIsoDate(todayInRome(now))!.getTime();
  return Array.from({ length: ACTIVITY_DAYS }, (_, i) =>
    new Date(today - (ACTIVITY_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

function practiceName(id: string, payload: unknown): string {
  return readPracticePayload(payload).name ?? `Pratica ${id.slice(0, 8)}`;
}

export async function dashboardSummary(
  prisma: PrismaClient,
  compliance: Pick<ComplianceService, 'listDeadlines'> | undefined,
  input: { tenantId: string; practiceUserId?: string; deadlineUserId?: string },
  now = new Date(),
): Promise<DashboardSummary> {
  const days = activityDays(now);
  // A day more than the chart, so the first Italian day is whole whatever the hour in UTC.
  const since = new Date(parseIsoDate(days[0])!.getTime() - DAY_MS);
  const practiceWhere: Prisma.PracticeWhereInput = {
    tenantId: input.tenantId,
    ...(input.practiceUserId ? personPracticesWhere(input.practiceUserId) : {}),
  };
  // A document needs a look when the reader asked for a check, until a person confirms it (A1).
  const review: Prisma.PracticeAttachmentWhereInput = {
    ocrStatus: 'COMPLETED',
    ocrResult: { path: ['reviewRequired'], equals: true },
    validatedAt: null,
    rejectedAt: null,
  };
  const attachmentWhere: Prisma.PracticeAttachmentWhereInput = {
    tenantId: input.tenantId,
    ...(input.practiceUserId ? { practice: personPracticesWhere(input.practiceUserId) } : {}),
  };

  const [groups, recent, toReview, unreadable, documents, deadlines, opened, received] =
    await Promise.all([
      prisma.practice.groupBy({ by: ['status'], where: practiceWhere, _count: { _all: true } }),
      prisma.practice.findMany({
        where: practiceWhere,
        orderBy: { updatedAt: 'desc' },
        take: LIST_SIZE,
        select: { id: true, status: true, payload: true, updatedAt: true },
      }),
      prisma.practiceAttachment.count({ where: { ...attachmentWhere, ...review } }),
      prisma.practiceAttachment.count({
        where: { ...attachmentWhere, ocrStatus: 'FAILED', validatedAt: null, rejectedAt: null },
      }),
      prisma.practiceAttachment.findMany({
        where: {
          ...attachmentWhere,
          OR: [review, { ocrStatus: 'FAILED', validatedAt: null, rejectedAt: null }],
        },
        orderBy: { createdAt: 'desc' },
        take: LIST_SIZE,
        select: {
          id: true,
          fileName: true,
          ocrStatus: true,
          practice: { select: { id: true, payload: true } },
        },
      }),
      compliance
        ? compliance.listDeadlines({
            tenantId: input.tenantId,
            status: 'OPEN',
            userId: input.deadlineUserId,
            withinDays: DEADLINE_HORIZON_DAYS,
          })
        : Promise.resolve([]),
      // Only the dates: the chart counts, it never shows which practice or document.
      prisma.practice.findMany({
        where: { ...practiceWhere, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.practiceAttachment.findMany({
        where: { ...attachmentWhere, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
    ]);

  const activity = new Map(days.map((date) => [date, { date, practices: 0, documents: 0 }]));
  for (const p of opened) {
    const day = activity.get(todayInRome(p.createdAt));
    if (day) day.practices += 1;
  }
  for (const a of received) {
    const day = activity.get(todayInRome(a.createdAt));
    if (day) day.documents += 1;
  }

  const byStatus = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<PracticeStatus, number>;
  for (const g of groups) byStatus[g.status] = g._count._all;

  return {
    practices: { total: STATES.reduce((sum, s) => sum + byStatus[s], 0), byStatus },
    deadlines: {
      // Fase 1B: deadlines for information only are listed, never counted as late or due.
      overdue: deadlines.filter((d) => d.certainty !== 'INFORMATIONAL' && d.daysLeft < 0).length,
      dueSoon: deadlines.filter((d) => d.certainty !== 'INFORMATIONAL' && d.daysLeft >= 0).length,
      upcoming: deadlines.slice(0, LIST_SIZE).map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        dueDate: d.dueDate,
        daysLeft: d.daysLeft,
        certainty: d.certainty,
      })),
    },
    documents: {
      toReview,
      unreadable,
      items: documents.map((a) => ({
        attachmentId: a.id,
        practiceId: a.practice.id,
        practiceName: practiceName(a.practice.id, a.practice.payload),
        fileName: a.fileName,
        reason: a.ocrStatus === 'FAILED' ? 'unreadable' : 'review',
      })),
    },
    recentPractices: recent.map((p) => ({
      id: p.id,
      name: practiceName(p.id, p.payload),
      status: p.status,
      updatedAt: p.updatedAt,
    })),
    activity: [...activity.values()],
  };
}
