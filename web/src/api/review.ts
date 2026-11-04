/** A1: documents waiting for a person and the fields that can be confirmed or corrected. */

import type { ValidatedData } from './practices';

export type FieldKind = 'text' | 'vat' | 'date' | 'amount' | 'percent' | 'category';

export type DocumentType = 'invoice' | 'delivery_note' | 'receipt' | 'certificate' | 'generic';

export const DOCUMENT_TYPES: DocumentType[] = [
  'receipt',
  'invoice',
  'delivery_note',
  'certificate',
  'generic',
];

/** The same fields the backend accepts (src/core/practice/attachment-validation.ts). */
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

export const CERTIFICATE_CATEGORY_LABELS: Record<string, string> = {
  BIO: 'Certificazione biologica',
  DURC: 'DURC',
  SICUREZZA_LAVORO: 'Formazione sicurezza sul lavoro',
  VISITA_MEDICA: 'Visita medica',
  PATENTINO: 'Patentino',
  ALTRO: 'Altro',
};

export type ReviewStatus = 'to_review' | 'validated';

export type ReviewItem = {
  attachmentId: string;
  practiceId: string;
  practiceName: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
  ocrStatus: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  reviewRequired: boolean;
  missingFields: string[];
  warnings: string[];
  read: { documentType: DocumentType | null; fields: Record<string, string | number | null> };
  validated: { data: ValidatedData; at: string; byEmail: string | null } | null;
};

export type ReviewPage = {
  items: ReviewItem[];
  total: number;
  page: number;
  totalPages: number;
};

export function reviewQuery(status: ReviewStatus, page: number): string {
  return `/attachments/review?status=${status}&page=${page}&limit=20`;
}

/** The values of a type, from what is known (read or confirmed); missing fields are empty. */
export function startingValues(
  type: DocumentType,
  known: Record<string, string | number | null>,
): Record<string, string> {
  return Object.fromEntries(
    VALIDATION_FIELDS[type].map(({ key }) => {
      const value = known[key];
      return [key, value === null || value === undefined ? '' : String(value)];
    }),
  );
}

/** Form values to the API: empty is null, amounts are numbers (comma accepted). */
export function toPayload(
  type: DocumentType,
  values: Record<string, string>,
): Record<string, string | number | null> {
  return Object.fromEntries(
    VALIDATION_FIELDS[type].map(({ key, kind }) => {
      const raw = (values[key] ?? '').trim();
      if (!raw) return [key, null];
      if (kind === 'amount' || kind === 'percent') {
        // «1.234,50» (Italian) or «1234.50»: with a comma, dots are thousands separators.
        const n = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
        return [key, Number.isFinite(n) ? n : raw];
      }
      return [key, raw];
    }),
  );
}
