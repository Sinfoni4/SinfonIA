import { personPracticesWhere } from '../../data/repositories/practice.repository.js';
import { computeChecklist, expectedDocumentsOf } from '../practice/document-checklist.js';
import { readPracticePayload } from '../practice/practice.payload.js';

import type { ComplianceService } from '../compliance/compliance.service.js';
import type { Prisma, PracticeStatus, PrismaClient } from '@prisma/client';

/**
 * Telegram Mini App: everything the «Oggi» and «Agenda» screens show, in one call, within the
 * caller's grants (own practices and deadlines for a member, the organization's for staff):
 * - the documents of the open practices, as a share of the expected ones that are confirmed;
 * - the open practices, the documents asked for and the files to confirm;
 * - the deadlines of the next 30 days (and overdue ones);
 * - the latest things that happened to those practices.
 * Names and document contents never enter the feed: only the kind of event and the practice.
 */

const OPEN: PracticeStatus[] = ['CREATED', 'VALIDATED', 'SUBMITTED'];
const LIST = 20;
const FEED = 6;
const FEED_EVENTS = [
  'ATTACHMENT_ADDED',
  'ATTACHMENT_VALIDATED',
  'ATTACHMENT_REJECTED',
  'ATTACHMENT_READ_RETRIED',
  'ATTACHMENT_READ_FAILED',
  'DOCUMENT_REQUESTED',
  'DOCUMENT_REQUEST_FULFILLED',
  'PRACTICE_CREATED',
  'PRACTICE_STATE_CHANGED',
];

export type MiniAppSummary = {
  documents: { confirmed: number; expected: number; percent: number | null };
  practices: Array<{
    id: string;
    name: string;
    status: PracticeStatus;
    documents: { confirmed: number; expected: number };
    openRequests: number;
  }>;
  requests: Array<{
    id: string;
    practiceId: string;
    practiceName: string;
    label: string | null;
    message: string;
    dueDate: string | null;
  }>;
  toConfirm: Array<{
    attachmentId: string;
    practiceId: string;
    practiceName: string;
    fileName: string;
  }>;
  deadlines: Array<{
    id: string;
    title: string;
    category: string;
    dueDate: string;
    daysLeft: number;
  }>;
  feed: Array<{
    type: string;
    practiceId: string;
    practiceName: string;
    at: string;
    to?: string;
    expectedLabel?: string;
  }>;
};

function nameOf(id: string, payload: unknown): string {
  return readPracticePayload(payload).name ?? `Pratica ${id.slice(0, 8)}`;
}

export async function miniAppSummary(
  prisma: PrismaClient,
  compliance: Pick<ComplianceService, 'listDeadlines'> | undefined,
  input: { tenantId: string; practiceUserId?: string; deadlineUserId?: string },
): Promise<MiniAppSummary> {
  const scope: Prisma.PracticeWhereInput = {
    tenantId: input.tenantId,
    ...(input.practiceUserId ? personPracticesWhere(input.practiceUserId) : {}),
  };
  const [open, deadlines] = await Promise.all([
    prisma.practice.findMany({
      where: { ...scope, status: { in: OPEN } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        status: true,
        payload: true,
        attachments: {
          select: {
            id: true,
            fileName: true,
            expectedKey: true,
            validatedAt: true,
            rejectedAt: true,
            rejectionReason: true,
            createdAt: true,
            ocrStatus: true,
            ocrResult: true,
          },
        },
        documentRequests: {
          where: { status: 'OPEN' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, expectedKey: true, message: true, dueDate: true },
        },
      },
    }),
    compliance
      ? compliance.listDeadlines({
          tenantId: input.tenantId,
          status: 'OPEN',
          userId: input.deadlineUserId,
          withinDays: 30,
        })
      : Promise.resolve([]),
  ]);

  let confirmed = 0;
  let expected = 0;
  const practices: MiniAppSummary['practices'] = [];
  const requests: MiniAppSummary['requests'] = [];
  const toConfirm: MiniAppSummary['toConfirm'] = [];
  for (const p of open) {
    const name = nameOf(p.id, p.payload);
    const docs = expectedDocumentsOf(p.payload);
    const list = computeChecklist(docs, p.attachments);
    const required = list.items.filter((i) => i.required);
    const ok = required.filter((i) => i.state === 'valid').length;
    confirmed += ok;
    expected += required.length;
    practices.push({
      id: p.id,
      name,
      status: p.status,
      documents: { confirmed: ok, expected: required.length },
      openRequests: p.documentRequests.length,
    });
    for (const r of p.documentRequests) {
      requests.push({
        id: r.id,
        practiceId: p.id,
        practiceName: name,
        label: r.expectedKey ? (docs.find((d) => d.key === r.expectedKey)?.label ?? null) : null,
        message: r.message,
        dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
      });
    }
    for (const a of p.attachments) {
      const review = (a.ocrResult as { reviewRequired?: unknown } | null)?.reviewRequired === true;
      if (a.ocrStatus === 'COMPLETED' && review && !a.validatedAt && !a.rejectedAt) {
        toConfirm.push({
          attachmentId: a.id,
          practiceId: p.id,
          practiceName: name,
          fileName: a.fileName,
        });
      }
    }
  }
  requests.sort((x, y) => (x.dueDate ?? '9999').localeCompare(y.dueDate ?? '9999'));

  // The latest events of the practices in scope (open or not), newest first.
  const reachable = await prisma.practice.findMany({
    where: scope,
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, payload: true },
  });
  const names = new Map(reachable.map((p) => [p.id, nameOf(p.id, p.payload)]));
  const labels = new Map(
    reachable.map((p) => [
      p.id,
      new Map(expectedDocumentsOf(p.payload).map((d) => [d.key, d.label])),
    ]),
  );
  const events =
    names.size === 0
      ? []
      : await prisma.auditLog.findMany({
          where: { tenantId: input.tenantId, eventType: { in: FEED_EVENTS } },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: { eventType: true, payload: true, createdAt: true },
        });
  const feed: MiniAppSummary['feed'] = [];
  for (const e of events) {
    const payload = (e.payload ?? {}) as {
      practiceId?: unknown;
      to?: unknown;
      expectedKey?: unknown;
    };
    const practiceId = typeof payload.practiceId === 'string' ? payload.practiceId : null;
    if (!practiceId || !names.has(practiceId)) continue;
    const label =
      typeof payload.expectedKey === 'string'
        ? labels.get(practiceId)?.get(payload.expectedKey)
        : undefined;
    feed.push({
      type: e.eventType,
      practiceId,
      practiceName: names.get(practiceId)!,
      at: e.createdAt.toISOString(),
      ...(typeof payload.to === 'string' ? { to: payload.to } : {}),
      ...(label ? { expectedLabel: label } : {}),
    });
    if (feed.length >= FEED) break;
  }

  return {
    documents: {
      confirmed,
      expected,
      percent: expected === 0 ? null : Math.round((confirmed / expected) * 100),
    },
    practices: practices.slice(0, LIST),
    requests: requests.slice(0, LIST),
    toConfirm: toConfirm.slice(0, LIST),
    deadlines: deadlines.slice(0, LIST).map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      dueDate: d.dueDate,
      daysLeft: d.daysLeft,
    })),
    feed,
  };
}
