import { readPracticePayload } from '../practice/practice.payload.js';

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The activity log of an organization for its administrators (P13, docs/PROGETTO_FRONTEND_V2.md
 * §3). Events are stored with free payloads: only a fixed list of plain fields leaves the server,
 * people are shown by email (never placeholder emails of chat accounts) and practices by name.
 * Identifiers of sessions, outbox messages or invitations are never shown.
 */

const SHOWN_FIELDS = [
  'role',
  'from',
  'to',
  'permission',
  'channel',
  'scope',
  'rows',
  'category',
  'dueDate',
  'name',
  'frequency',
  'scheduledExport',
  // Done by the platform console (FE7), whose administrator is not a member.
  'byPlatform',
] as const;

type ShownField = (typeof SHOWN_FIELDS)[number];

export type AuditPerson = { userId: string; email: string | null };

export type AuditEventView = {
  id: string;
  at: Date;
  type: string;
  actor: AuditPerson | null;
  /** The person the event is about (role change, revocation, delivery of an export). */
  target: AuditPerson | null;
  practice: { id: string; name: string | null } | null;
  /** Export period, when the event is an export. */
  period: string | null;
  details: Partial<Record<ShownField, string | number | boolean>>;
};

export type AuditPage = {
  items: AuditEventView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function listAuditEvents(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    page: number;
    limit: number;
    types?: string[];
    userId?: string;
    from?: Date;
    to?: Date;
  },
): Promise<AuditPage> {
  const where: Prisma.AuditLogWhereInput = {
    tenantId: input.tenantId,
    ...(input.types?.length ? { eventType: { in: input.types } } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.from || input.to
      ? {
          createdAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {}),
          },
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: { id: true, createdAt: true, eventType: true, userId: true, payload: true },
    }),
  ]);

  const payloads = rows.map((r) => record(r.payload));
  const targetOf = (p: Record<string, unknown>) => text(p.targetUserId) ?? text(p.recipientUserId);

  // People and practices of this organization only: an id of elsewhere resolves to nothing.
  const userIds = new Set<string>();
  rows.forEach((r, i) => {
    if (r.userId) userIds.add(r.userId);
    const target = targetOf(payloads[i]);
    if (target) userIds.add(target);
  });
  const practiceIds = new Set(
    payloads.map((p) => text(p.practiceId)).filter((id): id is string => Boolean(id)),
  );
  const [members, practices] = await Promise.all([
    userIds.size
      ? prisma.membership.findMany({
          where: { orgId: input.tenantId, userId: { in: [...userIds] } },
          select: { userId: true, user: { select: { email: true } } },
        })
      : Promise.resolve([]),
    practiceIds.size
      ? prisma.practice.findMany({
          where: { tenantId: input.tenantId, id: { in: [...practiceIds] } },
          select: { id: true, payload: true },
        })
      : Promise.resolve([]),
  ]);
  const emails = new Map(
    members.map((m) => [m.userId, PLACEHOLDER_EMAIL.test(m.user.email) ? null : m.user.email]),
  );
  const names = new Map(practices.map((p) => [p.id, readPracticePayload(p.payload).name]));
  const person = (userId: string | undefined | null): AuditPerson | null =>
    userId && emails.has(userId) ? { userId, email: emails.get(userId) ?? null } : null;

  const items = rows.map((r, i): AuditEventView => {
    const p = payloads[i];
    const details: AuditEventView['details'] = {};
    for (const key of SHOWN_FIELDS) {
      const value = p[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        details[key] = value;
      }
    }
    const practiceId = text(p.practiceId);
    return {
      id: r.id,
      at: r.createdAt,
      type: r.eventType,
      actor: person(r.userId),
      target: person(targetOf(p)),
      // A deleted practice keeps its event, without a name.
      practice: practiceId ? { id: practiceId, name: names.get(practiceId) ?? null } : null,
      period: text(record(p.filter).type) ?? null,
      details,
    };
  });

  return {
    items,
    total,
    page: input.page,
    limit: input.limit,
    totalPages: Math.ceil(total / input.limit),
  };
}
