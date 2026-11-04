import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import { readPracticePayload } from './practice.payload.js';

import type { OcrStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * Validation of the data read from documents (A1, docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.2,
 * decision H9): a person confirms or corrects the fields the reader extracted, and may change the
 * document type when it was recognised wrongly. The read result stays untouched; the confirmed
 * values are kept next to it and are the official ones. The audit records who confirmed, which
 * fields changed and the outcome, never the values.
 */

export const DOCUMENT_TYPES = [
  'invoice',
  'delivery_note',
  'receipt',
  'certificate',
  'generic',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

type FieldKind = 'text' | 'vat' | 'date' | 'amount' | 'percent' | 'category';

const CERTIFICATE_CATEGORIES = [
  'BIO',
  'DURC',
  'SICUREZZA_LAVORO',
  'VISITA_MEDICA',
  'PATENTINO',
  'ALTRO',
];

/** The fields a person can confirm or correct, per type (item lists stay as read). */
export const VALIDATION_FIELDS: Record<DocumentType, Array<{ key: string; kind: FieldKind }>> = {
  invoice: [
    { key: 'supplierName', kind: 'text' },
    { key: 'supplierVat', kind: 'vat' },
    { key: 'documentNumber', kind: 'text' },
    { key: 'documentDate', kind: 'date' },
    { key: 'taxableAmount', kind: 'amount' },
    { key: 'vatRate', kind: 'percent' },
    { key: 'vatAmount', kind: 'amount' },
    { key: 'totalAmount', kind: 'amount' },
  ],
  delivery_note: [
    { key: 'supplierName', kind: 'text' },
    { key: 'supplierVat', kind: 'vat' },
    { key: 'documentNumber', kind: 'text' },
    { key: 'documentDate', kind: 'date' },
    { key: 'recipientName', kind: 'text' },
    { key: 'destinationAddress', kind: 'text' },
    { key: 'carrierName', kind: 'text' },
  ],
  receipt: [
    { key: 'merchantName', kind: 'text' },
    { key: 'merchantVat', kind: 'vat' },
    { key: 'documentDate', kind: 'date' },
    { key: 'totalAmount', kind: 'amount' },
    { key: 'vatAmount', kind: 'amount' },
  ],
  certificate: [
    { key: 'category', kind: 'category' },
    { key: 'title', kind: 'text' },
    { key: 'issuer', kind: 'text' },
    { key: 'holderName', kind: 'text' },
    { key: 'certificateNumber', kind: 'text' },
    { key: 'issueDate', kind: 'date' },
    { key: 'expiryDate', kind: 'date' },
  ],
  generic: [{ key: 'title', kind: 'text' }],
};

export type FieldValue = string | number | null;

/** Field names in Italian, for the error messages shown to people. */
const FIELD_NAMES: Record<string, string> = {
  supplierName: 'Fornitore',
  supplierVat: 'P. IVA fornitore',
  merchantName: 'Esercente',
  merchantVat: 'P. IVA esercente',
  documentNumber: 'Numero',
  documentDate: 'Data',
  recipientName: 'Destinatario',
  destinationAddress: 'Indirizzo di destinazione',
  carrierName: 'Vettore',
  taxableAmount: 'Imponibile',
  vatRate: 'Aliquota IVA',
  vatAmount: 'IVA',
  totalAmount: 'Totale',
  title: 'Titolo',
  issuer: 'Emesso da',
  holderName: 'Intestatario',
  certificateNumber: 'Numero certificato',
  issueDate: 'Data di emissione',
  expiryDate: 'Scadenza',
  category: 'Categoria',
};

export class AttachmentValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_DOCUMENT_DATA';
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** One field, checked and normalised; throws AttachmentValidationError with an Italian message. */
function checkField(key: string, kind: FieldKind, value: unknown): FieldValue {
  const name = FIELD_NAMES[key] ?? key;
  if (value === null || value === undefined || value === '') return null;
  switch (kind) {
    case 'text': {
      if (typeof value !== 'string') break;
      const text = value.trim().replace(/\s+/g, ' ');
      if (text.length > 200) throw new AttachmentValidationError(`${name}: testo troppo lungo`);
      return text || null;
    }
    case 'vat': {
      if (typeof value !== 'string') break;
      const vat = value.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z0-9]{8,20}$/.test(vat)) {
        throw new AttachmentValidationError(`${name}: partita IVA o codice fiscale non valido`);
      }
      return vat;
    }
    case 'date':
      if (typeof value === 'string' && validDate(value)) return value;
      throw new AttachmentValidationError(`${name}: data non valida (AAAA-MM-GG)`);
    case 'amount':
    case 'percent': {
      const max = kind === 'percent' ? 100 : 1_000_000_000;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max) {
        return Math.round(value * 100) / 100;
      }
      throw new AttachmentValidationError(`${name}: importo non valido`);
    }
    case 'category':
      if (typeof value === 'string' && CERTIFICATE_CATEGORIES.includes(value)) return value;
      throw new AttachmentValidationError(`${name}: categoria non valida`);
  }
  throw new AttachmentValidationError(`${name}: valore non valido`);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The editable fields as the reader returned them, for the type it recognised. */
export function readValues(ocrResult: unknown): {
  documentType: DocumentType | null;
  fields: Record<string, FieldValue>;
} {
  const result = record(ocrResult);
  const type = isDocumentType(result.documentType) ? result.documentType : null;
  if (!type) return { documentType: null, fields: {} };
  const fields: Record<string, FieldValue> = {};
  for (const { key } of VALIDATION_FIELDS[type]) {
    const value = result[key];
    fields[key] = typeof value === 'string' || typeof value === 'number' ? value : null;
  }
  return { documentType: type, fields };
}

export type ValidatedData = { documentType: DocumentType; fields: Record<string, FieldValue> };

/** Checks a confirmation: a known type and only its fields, each valid. */
export function checkValidation(input: {
  documentType: string;
  fields: Record<string, unknown>;
}): ValidatedData {
  if (!isDocumentType(input.documentType)) {
    throw new AttachmentValidationError('Tipo di documento non valido');
  }
  const spec = VALIDATION_FIELDS[input.documentType];
  const known = new Set(spec.map((f) => f.key));
  const unknown = Object.keys(input.fields).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new AttachmentValidationError(`Campi non previsti: ${unknown.join(', ')}`);
  }
  const fields: Record<string, FieldValue> = {};
  for (const { key, kind } of spec) fields[key] = checkField(key, kind, input.fields[key]);
  return { documentType: input.documentType, fields };
}

/**
 * Confirms or corrects the data of an attachment. `ownerUserId` limits it to the caller's own
 * practices (own scope). Returns whether something was corrected.
 */
export async function validateAttachment(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    attachmentId: string;
    ownerUserId?: string;
    actorUserId: string;
    data: { documentType: string; fields: Record<string, unknown> };
  },
): Promise<{ outcome: 'confirmed' | 'corrected'; data: ValidatedData; validatedAt: Date }> {
  const data = checkValidation(input.data);
  return withTransaction(prisma, async (tx) => {
    const attachment = await tx.practiceAttachment.findFirst({
      where: {
        id: input.attachmentId,
        tenantId: input.tenantId,
        practiceId: input.practiceId,
        ...(input.ownerUserId ? { practice: { userId: input.ownerUserId } } : {}),
      },
      select: { ocrResult: true },
    });
    if (!attachment) throw new NotFoundError('Attachment not found');
    const read = readValues(attachment.ocrResult);
    const typeChanged = read.documentType !== data.documentType;
    const changed = Object.keys(data.fields).filter(
      (key) => typeChanged || (read.fields[key] ?? null) !== data.fields[key],
    );
    const outcome = typeChanged || changed.length > 0 ? 'corrected' : 'confirmed';
    const validatedAt = new Date();
    await tx.practiceAttachment.update({
      where: { id: input.attachmentId },
      data: {
        validatedData: data,
        validatedAt,
        validatedBy: input.actorUserId,
      },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: 'ATTACHMENT_VALIDATED',
      payload: {
        attachmentId: input.attachmentId,
        practiceId: input.practiceId,
        outcome,
        documentType: data.documentType,
        // Names of the changed fields only, never their values.
        correctedFields: typeChanged ? ['documentType', ...changed] : changed,
      },
    });
    return { outcome, data, validatedAt };
  });
}

// --- review queue -------------------------------------------------------------------------------

export type ReviewStatus = 'to_review' | 'validated' | 'all';

export type ReviewItem = {
  attachmentId: string;
  practiceId: string;
  practiceName: string;
  fileName: string;
  mimeType: string;
  createdAt: Date;
  ocrStatus: OcrStatus;
  reviewRequired: boolean;
  missingFields: string[];
  warnings: string[];
  read: { documentType: DocumentType | null; fields: Record<string, FieldValue> };
  validated: { data: ValidatedData; at: Date; byEmail: string | null } | null;
};

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

/** What still needs a person: read with doubts, or not read at all, and not yet confirmed. */
export function reviewQueueWhere(): Prisma.PracticeAttachmentWhereInput {
  return {
    validatedAt: null,
    OR: [
      { ocrStatus: 'FAILED' },
      { ocrStatus: 'COMPLETED', ocrResult: { path: ['reviewRequired'], equals: true } },
    ],
  };
}

export async function listReviewQueue(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    ownerUserId?: string;
    status: ReviewStatus;
    page: number;
    limit: number;
  },
): Promise<{ items: ReviewItem[]; total: number; page: number; totalPages: number }> {
  const where: Prisma.PracticeAttachmentWhereInput = {
    tenantId: input.tenantId,
    ...(input.ownerUserId ? { practice: { userId: input.ownerUserId } } : {}),
    ...(input.status === 'to_review'
      ? reviewQueueWhere()
      : input.status === 'validated'
        ? { validatedAt: { not: null } }
        : { ocrStatus: { in: ['COMPLETED', 'FAILED'] } }),
  };
  const [total, rows] = await Promise.all([
    prisma.practiceAttachment.count({ where }),
    prisma.practiceAttachment.findMany({
      where,
      orderBy: input.status === 'validated' ? { validatedAt: 'desc' } : { createdAt: 'asc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: {
        id: true,
        practiceId: true,
        fileName: true,
        mimeType: true,
        createdAt: true,
        ocrStatus: true,
        ocrResult: true,
        validatedData: true,
        validatedAt: true,
        validatedBy: true,
        practice: { select: { payload: true } },
      },
    }),
  ]);
  const validators = [
    ...new Set(rows.map((r) => r.validatedBy).filter((id): id is string => !!id)),
  ];
  const people = validators.length
    ? await prisma.membership.findMany({
        where: { orgId: input.tenantId, userId: { in: validators } },
        select: { userId: true, user: { select: { email: true } } },
      })
    : [];
  const emails = new Map(
    people.map((p) => [p.userId, PLACEHOLDER_EMAIL.test(p.user.email) ? null : p.user.email]),
  );
  return {
    items: rows.map((r) => {
      const result = record(r.ocrResult);
      const strings = (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      return {
        attachmentId: r.id,
        practiceId: r.practiceId,
        practiceName:
          readPracticePayload(r.practice.payload).name ?? `Pratica ${r.practiceId.slice(0, 8)}`,
        fileName: r.fileName,
        mimeType: r.mimeType,
        createdAt: r.createdAt,
        ocrStatus: r.ocrStatus,
        reviewRequired: result.reviewRequired === true,
        missingFields: strings(result.missingFields),
        warnings: strings(result.warnings),
        read: readValues(r.ocrResult),
        validated:
          r.validatedAt && r.validatedData
            ? {
                data: r.validatedData as unknown as ValidatedData,
                at: r.validatedAt,
                byEmail: r.validatedBy ? (emails.get(r.validatedBy) ?? null) : null,
              }
            : null,
      };
    }),
    total,
    page: input.page,
    totalPages: Math.ceil(total / input.limit),
  };
}

/**
 * A1 from the chat: the person who sent a document confirms its data as read. Own documents only
 * (attachments are always added to one's own practices); nothing to confirm when it was not read.
 */
export async function confirmReadDocument(
  prisma: PrismaClient,
  input: { tenantId: string; userId: string; practiceId: string; attachmentId: string },
): Promise<void> {
  const attachment = await prisma.practiceAttachment.findFirst({
    where: {
      id: input.attachmentId,
      tenantId: input.tenantId,
      practiceId: input.practiceId,
      practice: { userId: input.userId },
    },
    select: { ocrResult: true },
  });
  if (!attachment) throw new NotFoundError('Attachment not found');
  const read = readValues(attachment.ocrResult);
  if (!read.documentType) throw new AttachmentValidationError('Documento non letto');
  await validateAttachment(prisma, {
    tenantId: input.tenantId,
    practiceId: input.practiceId,
    attachmentId: input.attachmentId,
    ownerUserId: input.userId,
    actorUserId: input.userId,
    data: { documentType: read.documentType, fields: read.fields },
  });
}
