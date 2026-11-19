import { NotFoundError } from '../../data/errors/errors.js';
import { OutboxRepository } from '../../data/repositories/outbox.repository.js';
import { personPracticesWhere } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { practiceTypeOf } from '../../modules/registry.js';

import { practiceRecipient } from './practice-holder.js';
import { PracticeModuleError } from './practice-module.js';
import { readPracticePayload } from './practice.payload.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type { ExpectedDocument } from '../modules/module.contract.js';
import type { PrismaClient } from '@prisma/client';

/**
 * AGX-05: the document checklist of a practice, computed (never stored) from the documents its
 * type expects (the module) and the files attached to it. A file says which expected document it
 * is (`expectedKey`); a person confirms its data (valid) or rejects it with a reason.
 *
 * State of each expected document, from its best file: valid (data confirmed) before to_verify
 * (attached, not checked yet) before rejected; missing when no file is linked to it.
 */

export type ChecklistState = 'missing' | 'to_verify' | 'valid' | 'rejected';

export type ChecklistItem = {
  key: string;
  label: string;
  required: boolean;
  state: ChecklistState;
  /** The file that gives the state; null when missing. */
  attachment: { id: string; fileName: string } | null;
  /** Why the file was rejected, when the state is `rejected`. */
  rejectionReason: string | null;
};

export type DocumentChecklist = {
  items: ChecklistItem[];
  /** Every required document is valid. */
  complete: boolean;
  counts: Record<ChecklistState, number>;
};

export type ChecklistAttachment = {
  id: string;
  fileName: string;
  expectedKey: string | null;
  validatedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
};

/** A rejection wins over a confirmation made before it; a later confirmation clears it. */
export function attachmentState(a: {
  validatedAt: Date | null;
  rejectedAt: Date | null;
}): Exclude<ChecklistState, 'missing'> {
  if (a.rejectedAt) return 'rejected';
  return a.validatedAt ? 'valid' : 'to_verify';
}

const RANK: Record<Exclude<ChecklistState, 'missing'>, number> = {
  valid: 0,
  to_verify: 1,
  rejected: 2,
};

export function computeChecklist(
  expected: readonly ExpectedDocument[],
  attachments: readonly ChecklistAttachment[],
): DocumentChecklist {
  const counts: Record<ChecklistState, number> = {
    missing: 0,
    to_verify: 0,
    valid: 0,
    rejected: 0,
  };
  const items = expected.map((doc): ChecklistItem => {
    const best = attachments
      .filter((a) => a.expectedKey === doc.key)
      .sort(
        (x, y) =>
          RANK[attachmentState(x)] - RANK[attachmentState(y)] ||
          y.createdAt.getTime() - x.createdAt.getTime(),
      )[0];
    const state: ChecklistState = best ? attachmentState(best) : 'missing';
    counts[state] += 1;
    return {
      key: doc.key,
      label: doc.label,
      required: doc.required,
      state,
      attachment: best ? { id: best.id, fileName: best.fileName } : null,
      rejectionReason: state === 'rejected' ? (best?.rejectionReason ?? null) : null,
    };
  });
  return {
    items,
    complete: items.every((i) => !i.required || i.state === 'valid'),
    counts,
  };
}

/** The documents the type of a practice expects (none for older or unknown kinds). */
export function expectedDocumentsOf(payload: unknown): readonly ExpectedDocument[] {
  const { kind } = readPracticePayload(payload);
  if (kind === 'legacy' || kind === 'unknown') return [];
  return practiceTypeOf(kind)?.expectedDocuments ?? [];
}

/** Refuses a key that is not an expected document of the practice's type. */
export function requireExpectedKey(payload: unknown, key: string): void {
  if (!expectedDocumentsOf(payload).some((d) => d.key === key)) {
    throw new PracticeModuleError(
      'INVALID_EXPECTED_DOCUMENT',
      'Questo documento non è tra quelli previsti per il tipo di pratica',
    );
  }
}

const ATTACHMENT_SELECT = {
  id: true,
  fileName: true,
  expectedKey: true,
  validatedAt: true,
  rejectedAt: true,
  rejectionReason: true,
  createdAt: true,
} as const;

/** The checklist of a practice. Access to the practice is checked by the caller. */
export async function practiceChecklist(
  prisma: PrismaLike,
  input: { tenantId: string; practiceId: string },
): Promise<DocumentChecklist> {
  const practice = await prisma.practice.findFirst({
    where: { id: input.practiceId, tenantId: input.tenantId },
    select: { payload: true },
  });
  if (!practice) throw new NotFoundError('Practice not found');
  const attachments = await prisma.practiceAttachment.findMany({
    where: { tenantId: input.tenantId, practiceId: input.practiceId },
    select: ATTACHMENT_SELECT,
  });
  return computeChecklist(expectedDocumentsOf(practice.payload), attachments);
}

async function attachmentOf(
  tx: PrismaLike,
  input: { tenantId: string; practiceId: string; attachmentId: string; ownerUserId?: string },
) {
  const row = await tx.practiceAttachment.findFirst({
    where: {
      id: input.attachmentId,
      tenantId: input.tenantId,
      practiceId: input.practiceId,
      ...(input.ownerUserId ? { practice: personPracticesWhere(input.ownerUserId) } : {}),
    },
    select: {
      expectedKey: true,
      fileName: true,
      practice: { select: { payload: true, userId: true, holderUserId: true } },
    },
  });
  if (!row) throw new NotFoundError('Attachment not found');
  return row;
}

/**
 * Says which expected document a file is, or unlinks it (null). `ownerUserId` limits it to the
 * person's own practices (own scope).
 */
export async function setAttachmentExpectedKey(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    attachmentId: string;
    expectedKey: string | null;
    actorUserId: string;
    ownerUserId?: string;
  },
): Promise<{ expectedKey: string | null }> {
  return withTransaction(prisma, async (tx) => {
    const row = await attachmentOf(tx, input);
    if (input.expectedKey) requireExpectedKey(row.practice.payload, input.expectedKey);
    if (row.expectedKey === input.expectedKey) return { expectedKey: input.expectedKey };
    await tx.practiceAttachment.update({
      where: { id: input.attachmentId },
      data: { expectedKey: input.expectedKey },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'ATTACHMENT_EXPECTED_SET',
      payload: {
        practiceId: input.practiceId,
        attachmentId: input.attachmentId,
        ...(input.expectedKey ? { expectedKey: input.expectedKey } : { cleared: true }),
      },
    });
    return { expectedKey: input.expectedKey };
  });
}

/** AGX-05: whoever reaches the practice hears in chat that a document was rejected. */
export const ATTACHMENT_REJECTED = 'ATTACHMENT_REJECTED';

export type AttachmentRejectedPayload = {
  practiceId: string;
  attachmentId: string;
  /** Who receives the notice: the holder of the practice, or its creator. */
  userId: string;
};

export class RejectionError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_REJECTION';
  constructor(message: string) {
    super(message);
    this.name = 'RejectionError';
  }
}

/**
 * Rejects a file with a reason (3 to 500 characters). The reason is kept with the file and
 * shown to whoever reaches the practice; the audit records only that it happened. The holder of
 * the practice (or its creator) hears it in chat, unless they rejected it themselves.
 */
export async function rejectAttachment(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    attachmentId: string;
    reason: string;
    actorUserId: string;
  },
): Promise<{ rejectedAt: Date }> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new RejectionError('Scrivi il motivo del rifiuto (da 3 a 500 caratteri)');
  }
  return withTransaction(prisma, async (tx) => {
    const row = await attachmentOf(tx, input);
    const rejectedAt = new Date();
    await tx.practiceAttachment.update({
      where: { id: input.attachmentId },
      data: { rejectedAt, rejectedBy: input.actorUserId, rejectionReason: reason },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'ATTACHMENT_REJECTED',
      payload: {
        practiceId: input.practiceId,
        attachmentId: input.attachmentId,
        ...(row.expectedKey ? { expectedKey: row.expectedKey } : {}),
      },
    });
    const recipient = practiceRecipient(row.practice);
    if (recipient !== input.actorUserId) {
      await new OutboxRepository(tx).createMessage({
        tenantId: input.tenantId,
        eventType: ATTACHMENT_REJECTED,
        payload: {
          practiceId: input.practiceId,
          attachmentId: input.attachmentId,
          userId: recipient,
        } satisfies AttachmentRejectedPayload,
      });
    }
    return { rejectedAt };
  });
}
