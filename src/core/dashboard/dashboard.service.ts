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
};

function practiceName(id: string, payload: unknown): string {
  return readPracticePayload(payload).name ?? `Pratica ${id.slice(0, 8)}`;
}

export async function dashboardSummary(
  prisma: PrismaClient,
  compliance: Pick<ComplianceService, 'listDeadlines'> | undefined,
  input: { tenantId: string; practiceUserId?: string; deadlineUserId?: string },
): Promise<DashboardSummary> {
  const practiceWhere: Prisma.PracticeWhereInput = {
    tenantId: input.tenantId,
    ...(input.practiceUserId ? { userId: input.practiceUserId } : {}),
  };
  // A document needs a look when the reading failed or the reader asked for a check.
  const review: Prisma.PracticeAttachmentWhereInput = {
    ocrStatus: 'COMPLETED',
    ocrResult: { path: ['reviewRequired'], equals: true },
  };
  const attachmentWhere: Prisma.PracticeAttachmentWhereInput = {
    tenantId: input.tenantId,
    ...(input.practiceUserId ? { practice: { userId: input.practiceUserId } } : {}),
  };

  const [groups, recent, toReview, unreadable, documents, deadlines] = await Promise.all([
    prisma.practice.groupBy({ by: ['status'], where: practiceWhere, _count: { _all: true } }),
    prisma.practice.findMany({
      where: practiceWhere,
      orderBy: { updatedAt: 'desc' },
      take: LIST_SIZE,
      select: { id: true, status: true, payload: true, updatedAt: true },
    }),
    prisma.practiceAttachment.count({ where: { ...attachmentWhere, ...review } }),
    prisma.practiceAttachment.count({ where: { ...attachmentWhere, ocrStatus: 'FAILED' } }),
    prisma.practiceAttachment.findMany({
      where: { ...attachmentWhere, OR: [review, { ocrStatus: 'FAILED' }] },
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
  ]);

  const byStatus = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<PracticeStatus, number>;
  for (const g of groups) byStatus[g.status] = g._count._all;

  return {
    practices: { total: STATES.reduce((sum, s) => sum + byStatus[s], 0), byStatus },
    deadlines: {
      overdue: deadlines.filter((d) => d.daysLeft < 0).length,
      dueSoon: deadlines.filter((d) => d.daysLeft >= 0).length,
      upcoming: deadlines.slice(0, LIST_SIZE).map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        dueDate: d.dueDate,
        daysLeft: d.daysLeft,
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
  };
}
