import { NotFoundError } from '../../data/errors/errors.js';
import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import { expectedDocumentsOf, requireExpectedKey } from './document-checklist.js';
import { practiceRecipient } from './practice-holder.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type { DocumentRequestStatus, PrismaClient } from '@prisma/client';

/**
 * AGX-06: a request for a document on a practice (integration), in both directions.
 *
 * - Staff of the organization, or someone working through a delegation with UPDATE (the network),
 *   ask for a document: an expected one of the practice's type (AGX-05) or anything else, with a
 *   message and an optional date.
 * - Whoever the practice belongs to (its holder, or its creator) hears it in chat.
 * - They answer by sending the file, on any channel: the file fulfils the request (matched by
 *   the expected document, or the only open request of the practice), and who asked hears it.
 * - Staff can also link a file to a request, or cancel it.
 */

export const DOCUMENT_REQUESTED = 'DOCUMENT_REQUESTED';
export const DOCUMENT_REQUEST_FULFILLED = 'DOCUMENT_REQUEST_FULFILLED';

export type DocumentRequestedPayload = { requestId: string; userId: string };
export type DocumentRequestFulfilledPayload = { requestId: string; userId: string };

export class DocumentRequestError extends Error {
  readonly statusCode: 400 | 409;
  readonly code = 'INVALID_DOCUMENT_REQUEST';
  constructor(message: string, statusCode: 400 | 409 = 400) {
    super(message);
    this.name = 'DocumentRequestError';
    this.statusCode = statusCode;
  }
}

export type DocumentRequestView = {
  id: string;
  practiceId: string;
  expectedKey: string | null;
  /** The label of the expected document, when there is one. */
  expectedLabel: string | null;
  message: string;
  dueDate: string | null;
  status: DocumentRequestStatus;
  createdAt: Date;
  fulfilledAt: Date | null;
  fulfilledAttachmentId: string | null;
  cancelledAt: Date | null;
};

const REQUEST_SELECT = {
  id: true,
  practiceId: true,
  expectedKey: true,
  message: true,
  dueDate: true,
  status: true,
  createdAt: true,
  fulfilledAt: true,
  fulfilledAttachmentId: true,
  cancelledAt: true,
  practice: { select: { payload: true } },
} as const;

type RequestRow = {
  id: string;
  practiceId: string;
  expectedKey: string | null;
  message: string;
  dueDate: Date | null;
  status: DocumentRequestStatus;
  createdAt: Date;
  fulfilledAt: Date | null;
  fulfilledAttachmentId: string | null;
  cancelledAt: Date | null;
  practice: { payload: unknown };
};

function toView(row: RequestRow): DocumentRequestView {
  const label = row.expectedKey
    ? (expectedDocumentsOf(row.practice.payload).find((d) => d.key === row.expectedKey)?.label ??
      null)
    : null;
  return {
    id: row.id,
    practiceId: row.practiceId,
    expectedKey: row.expectedKey,
    expectedLabel: label,
    message: row.message,
    dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
    status: row.status,
    createdAt: row.createdAt,
    fulfilledAt: row.fulfilledAt,
    fulfilledAttachmentId: row.fulfilledAttachmentId,
    cancelledAt: row.cancelledAt,
  };
}

/** The requests of a practice, open ones first, newest first. Access is checked by the caller. */
export async function listDocumentRequests(
  prisma: PrismaLike,
  input: { tenantId: string; practiceId: string },
): Promise<DocumentRequestView[]> {
  const rows = await prisma.documentRequest.findMany({
    where: { tenantId: input.tenantId, practiceId: input.practiceId },
    orderBy: { createdAt: 'desc' },
    select: REQUEST_SELECT,
  });
  const views = rows.map(toView);
  return [...views.filter((r) => r.status === 'OPEN'), ...views.filter((r) => r.status !== 'OPEN')];
}

/** The open requests of the organization, oldest first (staff queue). */
export async function listOpenDocumentRequests(
  prisma: PrismaLike,
  tenantId: string,
): Promise<Array<DocumentRequestView & { practiceName: string | null }>> {
  const rows = await prisma.documentRequest.findMany({
    where: { tenantId, status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: REQUEST_SELECT,
  });
  return rows.map((r) => {
    const payload = r.practice.payload as { name?: unknown } | null;
    return {
      ...toView(r),
      practiceName: typeof payload?.name === 'string' ? payload.name : null,
    };
  });
}

/** Practices of the person (holder or creator) that have open requests, for the chat. */
export async function practicesWithOpenRequests(
  prisma: PrismaLike,
  input: { tenantId: string; userId: string },
): Promise<string[]> {
  const rows = await prisma.documentRequest.findMany({
    where: {
      tenantId: input.tenantId,
      status: 'OPEN',
      practice: {
        OR: [{ holderUserId: input.userId }, { userId: input.userId, holderUserId: null }],
      },
    },
    distinct: ['practiceId'],
    select: { practiceId: true },
  });
  return rows.map((r) => r.practiceId);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Asks for a document. `requesterOrgId` is where the person who asks works (the grantor's
 * organization, or theirs through a delegation `grantId`): they hear the answer there.
 */
export async function createDocumentRequest(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    expectedKey?: string | null;
    message: string;
    dueDate?: string | null;
    actorUserId: string;
    requesterOrgId: string;
    grantId?: string;
    channel: string;
  },
): Promise<DocumentRequestView> {
  const message = input.message.trim();
  if (message.length < 3 || message.length > 1000) {
    throw new DocumentRequestError('Scrivi cosa serve (da 3 a 1000 caratteri)');
  }
  if (input.dueDate && (!DATE.test(input.dueDate) || Number.isNaN(Date.parse(input.dueDate)))) {
    throw new DocumentRequestError('Data non valida');
  }
  return withTransaction(prisma, async (tx) => {
    const practice = await tx.practice.findFirst({
      where: { id: input.practiceId, tenantId: input.tenantId },
      select: { payload: true, userId: true, holderUserId: true, status: true },
    });
    if (!practice) throw new NotFoundError('Practice not found');
    if (practice.status === 'COMPLETED' || practice.status === 'FAILED') {
      throw new DocumentRequestError('La pratica è chiusa: non si possono chiedere documenti', 409);
    }
    if (input.expectedKey) requireExpectedKey(practice.payload, input.expectedKey);
    const row = await tx.documentRequest.create({
      data: {
        tenantId: input.tenantId,
        practiceId: input.practiceId,
        expectedKey: input.expectedKey ?? null,
        message,
        dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null,
        requestedBy: input.actorUserId,
        requesterOrgId: input.requesterOrgId,
        grantId: input.grantId ?? null,
      },
      select: REQUEST_SELECT,
    });
    // The text of the request goes to the person in chat, never into the audit.
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'DOCUMENT_REQUESTED',
      payload: {
        practiceId: input.practiceId,
        requestId: row.id,
        channel: input.channel,
        ...(input.expectedKey ? { expectedKey: input.expectedKey } : {}),
      },
    });
    const recipient = practiceRecipient(practice);
    if (recipient !== input.actorUserId) {
      await new OutboxRepository(tx).createMessage({
        tenantId: input.tenantId,
        eventType: DOCUMENT_REQUESTED,
        payload: { requestId: row.id, userId: recipient } satisfies DocumentRequestedPayload,
      });
    }
    return toView(row);
  });
}

export async function cancelDocumentRequest(
  prisma: PrismaClient,
  input: { tenantId: string; practiceId: string; requestId: string; actorUserId: string },
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const updated = await tx.documentRequest.updateMany({
      where: {
        id: input.requestId,
        tenantId: input.tenantId,
        practiceId: input.practiceId,
        status: 'OPEN',
      },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: input.actorUserId },
    });
    if (updated.count === 0) {
      const exists = await tx.documentRequest.count({
        where: { id: input.requestId, tenantId: input.tenantId, practiceId: input.practiceId },
      });
      if (!exists) throw new NotFoundError('Document request not found');
      throw new DocumentRequestError('La richiesta non è più aperta', 409);
    }
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'DOCUMENT_REQUEST_CANCELLED',
      payload: { practiceId: input.practiceId, requestId: input.requestId },
    });
  });
}

/** Refuses a request id that is not open on that practice, before a file is stored for it. */
export async function requireOpenRequest(
  prisma: PrismaLike,
  input: { tenantId: string; practiceId: string; requestId: string },
): Promise<void> {
  const found = await prisma.documentRequest.count({
    where: {
      id: input.requestId,
      tenantId: input.tenantId,
      practiceId: input.practiceId,
      status: 'OPEN',
    },
  });
  if (!found) throw new DocumentRequestError('La richiesta non è più aperta', 409);
}

export type FulfilledRequest = { id: string; message: string; expectedLabel: string | null };

/**
 * Fulfils a request with a file just attached to its practice. The request is the one named
 * (`requestId`), otherwise the oldest open one for the same expected document, otherwise the only
 * open request of the practice when the file says nothing. With several candidates and no hint
 * nothing is matched: staff link the file. Returns the request fulfilled, if any.
 */
export async function fulfilWithAttachment(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    attachmentId: string;
    expectedKey: string | null;
    actorUserId: string;
    requestId?: string;
  },
): Promise<FulfilledRequest | null> {
  return withTransaction(prisma, async (tx) => {
    const open = await tx.documentRequest.findMany({
      where: { tenantId: input.tenantId, practiceId: input.practiceId, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      select: REQUEST_SELECT,
    });
    const chosen = input.requestId
      ? open.find((r) => r.id === input.requestId)
      : input.expectedKey
        ? (open.find((r) => r.expectedKey === input.expectedKey) ??
          (open.length === 1 && !open[0].expectedKey ? open[0] : undefined))
        : open.length === 1
          ? open[0]
          : undefined;
    if (!chosen) {
      if (input.requestId) throw new DocumentRequestError('La richiesta non è più aperta', 409);
      return null;
    }
    return markFulfilled(tx, { ...input, request: chosen });
  });
}

/** Staff link a file of the practice to an open request (when it was not matched by itself). */
export async function fulfilRequestManually(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    requestId: string;
    attachmentId: string;
    actorUserId: string;
  },
): Promise<FulfilledRequest> {
  return withTransaction(prisma, async (tx) => {
    const file = await tx.practiceAttachment.findFirst({
      where: { id: input.attachmentId, tenantId: input.tenantId, practiceId: input.practiceId },
      select: { expectedKey: true },
    });
    if (!file) throw new NotFoundError('Attachment not found');
    const request = await tx.documentRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, practiceId: input.practiceId },
      select: REQUEST_SELECT,
    });
    if (!request) throw new NotFoundError('Document request not found');
    if (request.status !== 'OPEN') {
      throw new DocumentRequestError('La richiesta non è più aperta', 409);
    }
    return markFulfilled(tx, { ...input, expectedKey: file.expectedKey, request });
  });
}

async function markFulfilled(
  tx: PrismaLike,
  input: {
    tenantId: string;
    practiceId: string;
    attachmentId: string;
    expectedKey: string | null;
    actorUserId: string;
    request: RequestRow;
  },
): Promise<FulfilledRequest> {
  const done = await tx.documentRequest.updateMany({
    where: { id: input.request.id, status: 'OPEN' },
    data: {
      status: 'FULFILLED',
      fulfilledAt: new Date(),
      fulfilledBy: input.actorUserId,
      fulfilledAttachmentId: input.attachmentId,
    },
  });
  if (done.count === 0) throw new DocumentRequestError('La richiesta non è più aperta', 409);
  // The file becomes the expected document asked for, unless it already says another one.
  if (input.request.expectedKey && !input.expectedKey) {
    await tx.practiceAttachment.update({
      where: { id: input.attachmentId },
      data: { expectedKey: input.request.expectedKey },
    });
  }
  await new AuditService(tx).logEvent({
    tenantId: input.tenantId,
    userId: input.actorUserId,
    eventType: 'DOCUMENT_REQUEST_FULFILLED',
    payload: {
      practiceId: input.practiceId,
      requestId: input.request.id,
      attachmentId: input.attachmentId,
    },
  });
  const request = await tx.documentRequest.findUniqueOrThrow({
    where: { id: input.request.id },
    select: { requestedBy: true, requesterOrgId: true },
  });
  if (request.requestedBy && request.requesterOrgId && request.requestedBy !== input.actorUserId) {
    // In the organization of who asked: the network's, when they asked through a delegation.
    await new OutboxRepository(tx).createMessage({
      tenantId: request.requesterOrgId,
      eventType: DOCUMENT_REQUEST_FULFILLED,
      payload: {
        requestId: input.request.id,
        userId: request.requestedBy,
      } satisfies DocumentRequestFulfilledPayload,
    });
  }
  const view = toView(input.request);
  return { id: view.id, message: view.message, expectedLabel: view.expectedLabel };
}
