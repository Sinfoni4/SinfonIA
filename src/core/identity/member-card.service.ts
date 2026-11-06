import { NotFoundError } from '../../data/errors/errors.js';
import { personPracticesWhere } from '../../data/repositories/practice.repository.js';
import { readPracticePayload } from '../practice/practice.payload.js';

import type { PracticeStatus, PrismaClient, UserRole } from '@prisma/client';

/**
 * Cantiere 3 (ELENCO_STEP_MANCANTI §1.8, item 43): one page about one member of the
 * organization, for its administrators: the membership, the practices the person created or
 * follows, the deadlines that refer to them and the documents of their practices. Only data of
 * the caller's organization; no chat history (H5).
 */

const LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MemberCardPractice = {
  id: string;
  name: string;
  status: PracticeStatus;
  typeLabel: string;
  updatedAt: Date;
};

export type MemberCard = {
  userId: string;
  email: string | null;
  role: UserRole;
  customRole: { id: string; name: string } | null;
  status: string;
  since: Date;
  practices: {
    total: number;
    open: number;
    /** The most recent ones, at most 50. */
    items: MemberCardPractice[];
  };
  assigned: MemberCardPractice[];
  deadlines: Array<{
    id: string;
    title: string;
    category: string;
    dueDate: string;
    daysLeft: number;
  }>;
  documents: {
    total: number;
    /** Read and still to be confirmed by a person (A1). */
    toReview: number;
    items: Array<{
      id: string;
      practiceId: string;
      practiceName: string;
      fileName: string;
      ocrStatus: string;
      validated: boolean;
      createdAt: Date;
    }>;
  };
};

const OPEN: PracticeStatus[] = ['CREATED', 'VALIDATED', 'SUBMITTED'];

function toPractice(row: {
  id: string;
  status: PracticeStatus;
  payload: unknown;
  updatedAt: Date;
}): MemberCardPractice {
  const payload = readPracticePayload(row.payload);
  return {
    id: row.id,
    name: payload.name ?? 'Pratica senza nome',
    status: row.status,
    typeLabel: payload.typeLabel,
    updatedAt: row.updatedAt,
  };
}

export async function memberCard(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  now = new Date(),
): Promise<MemberCard> {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: {
      role: true,
      status: true,
      createdAt: true,
      user: { select: { email: true } },
      customRole: { select: { id: true, name: true } },
    },
  });
  if (!membership) throw new NotFoundError('Member not found');

  const practiceSelect = { id: true, status: true, payload: true, updatedAt: true } as const;
  // AGX-03: the person's practices are those they created and those opened for them.
  const mine = personPracticesWhere(userId);
  const today = new Date(now.toISOString().slice(0, 10));
  const [total, open, recent, assigned, deadlines, documents, toReview, recentDocuments] =
    await Promise.all([
      prisma.practice.count({ where: { tenantId: orgId, ...mine } }),
      prisma.practice.count({ where: { tenantId: orgId, ...mine, status: { in: OPEN } } }),
      prisma.practice.findMany({
        where: { tenantId: orgId, ...mine },
        orderBy: { updatedAt: 'desc' },
        take: LIMIT,
        select: practiceSelect,
      }),
      prisma.practice.findMany({
        where: { tenantId: orgId, assignedTo: userId, status: { in: OPEN } },
        orderBy: { updatedAt: 'desc' },
        take: LIMIT,
        select: practiceSelect,
      }),
      prisma.complianceDeadline.findMany({
        where: { tenantId: orgId, userId, status: 'OPEN' },
        orderBy: { dueDate: 'asc' },
        take: LIMIT,
        select: { id: true, title: true, category: true, dueDate: true },
      }),
      prisma.practiceAttachment.count({ where: { tenantId: orgId, practice: mine } }),
      prisma.practiceAttachment.count({
        where: {
          tenantId: orgId,
          practice: mine,
          ocrStatus: 'COMPLETED',
          validatedAt: null,
        },
      }),
      prisma.practiceAttachment.findMany({
        where: { tenantId: orgId, practice: mine },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
        select: {
          id: true,
          practiceId: true,
          fileName: true,
          ocrStatus: true,
          validatedAt: true,
          createdAt: true,
          practice: { select: { payload: true } },
        },
      }),
    ]);

  return {
    userId,
    // Placeholder emails of accounts created by chat are not contacts.
    email: membership.user.email.endsWith('@local.invalid') ? null : membership.user.email,
    role: membership.role,
    customRole: membership.customRole,
    status: membership.status,
    since: membership.createdAt,
    practices: { total, open, items: recent.map(toPractice) },
    assigned: assigned.map(toPractice),
    deadlines: deadlines.map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      dueDate: d.dueDate.toISOString().slice(0, 10),
      daysLeft: Math.round((d.dueDate.getTime() - today.getTime()) / DAY_MS),
    })),
    documents: {
      total: documents,
      toReview,
      items: recentDocuments.map((a) => ({
        id: a.id,
        practiceId: a.practiceId,
        practiceName: readPracticePayload(a.practice.payload).name ?? 'Pratica senza nome',
        fileName: a.fileName,
        ocrStatus: a.ocrStatus,
        validated: a.validatedAt !== null,
        createdAt: a.createdAt,
      })),
    },
  };
}
