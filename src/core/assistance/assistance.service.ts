import { NotFoundError } from '../../data/errors/errors.js';
import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { recordUsage } from '../usage/usage.service.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type {
  AssistanceStatus,
  AssistanceTopic,
  ChannelType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

/**
 * «Parla con un operatore» (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.3, decision H10): a person
 * asks for help from the chat, choosing a topic with a button; the operators are told in chat and
 * handle the request from the dashboard. No live chat and no free text are kept (that waits for
 * H5): only the topic, who asked, through which channel, and who handled it.
 */

export const ASSISTANCE_REQUESTED = 'ASSISTANCE_REQUESTED';
export const ASSISTANCE_UPDATED = 'ASSISTANCE_UPDATED';

export const ASSISTANCE_TOPICS = ['PRACTICE', 'DOCUMENT', 'DEADLINE', 'OTHER'] as const;

export const TOPIC_LABELS: Record<AssistanceTopic, string> = {
  PRACTICE: 'una pratica',
  DOCUMENT: 'un documento',
  DEADLINE: 'una scadenza',
  OTHER: 'altro',
};

export type AssistanceAction = 'take' | 'close';

export type AssistanceRequestedPayload = { requestId: string };
export type AssistanceUpdatedPayload = {
  requestId: string;
  userId: string;
  action: AssistanceAction;
};

export class AssistanceError extends Error {
  readonly statusCode = 409;
  readonly code = 'ASSISTANCE_STATE';
  constructor(message: string) {
    super(message);
    this.name = 'AssistanceError';
  }
}

const NOT_CLOSED = { not: 'CLOSED' } as const;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

/**
 * Records the request and tells the operators. A person has at most one request still to be
 * handled per organization: asking again returns that one (`created: false`).
 */
export async function requestAssistance(
  prisma: PrismaClient,
  input: { tenantId: string; userId: string; topic: AssistanceTopic; channel: ChannelType },
): Promise<{ created: boolean; createdAt: Date }> {
  const open = () =>
    prisma.assistanceRequest.findFirst({
      where: { tenantId: input.tenantId, userId: input.userId, status: NOT_CLOSED },
      select: { createdAt: true },
    });
  const existing = await open();
  if (existing) return { created: false, createdAt: existing.createdAt };
  try {
    return await withTransaction(prisma, async (tx) => {
      const request = await tx.assistanceRequest.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          topic: input.topic,
          channel: input.channel,
        },
        select: { id: true, createdAt: true },
      });
      await new AuditService(tx).logEvent({
        tenantId: input.tenantId,
        userId: input.userId,
        eventType: 'ASSISTANCE_REQUESTED',
        payload: {
          requestId: request.id,
          topic: input.topic,
          // Lower case, like the channels of the other events of the log.
          channel: input.channel.toLowerCase(),
        },
      });
      await new OutboxRepository(tx).createMessage({
        tenantId: input.tenantId,
        eventType: ASSISTANCE_REQUESTED,
        payload: { requestId: request.id } satisfies AssistanceRequestedPayload,
      });
      return { created: true, createdAt: request.createdAt };
    });
  } catch (err: unknown) {
    // Two taps at the same time: the other one created it.
    const other = isUniqueViolation(err) ? await open() : null;
    if (other) return { created: false, createdAt: other.createdAt };
    throw err;
  }
}

export type AssistanceListStatus = 'open' | 'closed' | 'all';

export type AssistanceItem = {
  id: string;
  topic: AssistanceTopic;
  channel: ChannelType;
  status: AssistanceStatus;
  createdAt: Date;
  takenAt: Date | null;
  closedAt: Date | null;
  requester: {
    userId: string;
    /** A real address only, never the placeholder of chat-only accounts. */
    email: string | null;
    /** WhatsApp numbers of the person, the way an operator can call them back. */
    phones: string[];
    channels: ChannelType[];
    practices: number;
  };
  takenByEmail: string | null;
  closedByEmail: string | null;
};

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

function statusWhere(status: AssistanceListStatus): Prisma.AssistanceRequestWhereInput {
  if (status === 'open') return { status: NOT_CLOSED };
  if (status === 'closed') return { status: 'CLOSED' };
  return {};
}

export async function listAssistanceRequests(
  prisma: PrismaClient,
  input: { tenantId: string; status: AssistanceListStatus; page: number; limit: number },
): Promise<{ items: AssistanceItem[]; total: number; page: number; totalPages: number }> {
  const where: Prisma.AssistanceRequestWhereInput = {
    tenantId: input.tenantId,
    ...statusWhere(input.status),
  };
  const [total, rows] = await Promise.all([
    prisma.assistanceRequest.count({ where }),
    prisma.assistanceRequest.findMany({
      where,
      orderBy: input.status === 'closed' ? { closedAt: 'desc' } : { createdAt: 'asc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: {
        id: true,
        topic: true,
        channel: true,
        status: true,
        createdAt: true,
        takenAt: true,
        closedAt: true,
        takenBy: true,
        closedBy: true,
        user: {
          select: {
            id: true,
            email: true,
            channelIdentities: {
              where: { revokedAt: null },
              select: { channel: true, externalId: true },
            },
            _count: { select: { practices: { where: { tenantId: input.tenantId } } } },
          },
        },
      },
    }),
  ]);
  const staffIds = [
    ...new Set(rows.flatMap((r) => [r.takenBy, r.closedBy]).filter((id) => id !== null)),
  ];
  const staff = staffIds.length
    ? await prisma.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, email: true },
      })
    : [];
  const emailOf = (id: string | null) =>
    id ? (staff.find((s) => s.id === id)?.email ?? null) : null;
  return {
    items: rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      channel: r.channel,
      status: r.status,
      createdAt: r.createdAt,
      takenAt: r.takenAt,
      closedAt: r.closedAt,
      requester: {
        userId: r.user.id,
        email: PLACEHOLDER_EMAIL.test(r.user.email) ? null : r.user.email,
        phones: r.user.channelIdentities
          .filter((c) => c.channel === 'WHATSAPP')
          .map((c) => c.externalId),
        channels: [...new Set(r.user.channelIdentities.map((c) => c.channel))],
        practices: r.user._count.practices,
      },
      takenByEmail: emailOf(r.takenBy),
      closedByEmail: emailOf(r.closedBy),
    })),
    total,
    page: input.page,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/** Requests still to be handled, for the dashboard summary. */
export function countOpenAssistance(prisma: PrismaLike, tenantId: string): Promise<number> {
  return prisma.assistanceRequest.count({ where: { tenantId, status: NOT_CLOSED } });
}

/**
 * An operator takes the request in charge or closes it; the person is told in chat. Taking it is
 * possible only while it is open; closing while it is not closed yet.
 */
export async function updateAssistanceRequest(
  prisma: PrismaClient,
  input: { tenantId: string; id: string; actorUserId: string; action: AssistanceAction },
): Promise<{ status: AssistanceStatus }> {
  return withTransaction(prisma, async (tx) => {
    const request = await tx.assistanceRequest.findFirst({
      where: { id: input.id, tenantId: input.tenantId },
      select: { status: true, userId: true },
    });
    if (!request) throw new NotFoundError('Assistance request not found');
    const now = new Date();
    const allowed: AssistanceStatus[] =
      input.action === 'take' ? ['OPEN'] : ['OPEN', 'IN_PROGRESS'];
    const data: Prisma.AssistanceRequestUpdateManyMutationInput =
      input.action === 'take'
        ? { status: 'IN_PROGRESS', takenBy: input.actorUserId, takenAt: now }
        : { status: 'CLOSED', closedBy: input.actorUserId, closedAt: now };
    // Conditional update: of two operators acting at once, only the first one wins.
    const updated = await tx.assistanceRequest.updateMany({
      where: { id: input.id, tenantId: input.tenantId, status: { in: allowed } },
      data,
    });
    if (updated.count === 0) {
      throw new AssistanceError(
        input.action === 'take'
          ? 'La richiesta è già stata presa in carico o chiusa'
          : 'La richiesta è già chiusa',
      );
    }
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: input.action === 'take' ? 'ASSISTANCE_TAKEN' : 'ASSISTANCE_CLOSED',
      payload: { requestId: input.id },
    });
    // AGX-07: a request closes once (the conditional update above), so it is counted once.
    if (input.action === 'close') {
      await recordUsage(tx, [
        {
          key: `assistance.closed:${input.id}`,
          tenantId: input.tenantId,
          kind: 'ASSISTANCE_CLOSED',
          userId: input.actorUserId,
        },
      ]);
    }
    await new OutboxRepository(tx).createMessage({
      tenantId: input.tenantId,
      eventType: ASSISTANCE_UPDATED,
      payload: {
        requestId: input.id,
        userId: request.userId,
        action: input.action,
      } satisfies AssistanceUpdatedPayload,
    });
    return { status: input.action === 'take' ? 'IN_PROGRESS' : 'CLOSED' };
  });
}
