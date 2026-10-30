/** Practices and their attachments, as the API returns them (src/core/practice). */

export type PracticeState = 'CREATED' | 'VALIDATED' | 'SUBMITTED' | 'FAILED' | 'COMPLETED';
export type PracticeKind = 'generic' | 'music' | 'artist';

export type Practice = {
  id: string;
  userId: string;
  status: PracticeState;
  name: string;
  kind: PracticeKind;
  typeLabel: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type PracticeDetail = Practice & { allowedTransitions: PracticeState[] };

export type PracticePage = {
  items: Practice[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type OcrStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type Attachment = {
  id: string;
  practiceId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  ocrStatus: OcrStatus;
  ocrResult: Record<string, unknown> | null;
  createdAt: string;
};

export type PracticeFilters = {
  page: number;
  search: string;
  status: PracticeState | '';
  /** Only the caller's practices (for those who see the whole organization). */
  mine: boolean;
};

export const PAGE_SIZE = 20;

export function practicesQuery(filters: PracticeFilters, userId: string): string {
  const params = new URLSearchParams({
    page: String(filters.page),
    limit: String(PAGE_SIZE),
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.status) params.set('status', filters.status);
  if (filters.mine) params.set('userId', userId);
  return `/practices?${params.toString()}`;
}

export const STATE_LABELS: Record<PracticeState, string> = {
  CREATED: 'Creata',
  VALIDATED: 'Validata',
  SUBMITTED: 'Inviata',
  FAILED: 'Non riuscita',
  COMPLETED: 'Completata',
};

/** The button that moves a practice to a state. */
export const TRANSITION_LABELS: Record<PracticeState, string> = {
  CREATED: 'Riporta a creata',
  VALIDATED: 'Valida',
  SUBMITTED: 'Segna come inviata',
  FAILED: 'Segna come non riuscita',
  COMPLETED: 'Completa',
};

export const KIND_LABELS: Record<PracticeKind, string> = {
  generic: 'Generica',
  music: 'Musicale',
  artist: 'Artista',
};

export const OCR_LABELS: Record<OcrStatus, string> = {
  PENDING: 'In attesa di lettura',
  PROCESSING: 'Lettura in corso',
  COMPLETED: 'Letto',
  FAILED: 'Lettura non riuscita',
};

const DOCUMENT_TYPES: Record<string, string> = {
  invoice: 'Fattura',
  delivery_note: 'Documento di trasporto',
  receipt: 'Ricevuta',
  certificate: 'Certificato',
  generic: 'Documento',
};

const FIELD_LABELS: Record<string, string> = {
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
  vatRate: 'Aliquota IVA (%)',
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

const AMOUNTS = new Set(['taxableAmount', 'vatAmount', 'totalAmount']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The data read from a document, as label and value, in a stable order; text only. */
export function readFields(result: Record<string, unknown> | null): {
  documentType: string | null;
  fields: Array<{ label: string; value: string }>;
  reviewRequired: boolean;
  warnings: string[];
} {
  if (!result) return { documentType: null, fields: [], reviewRequired: false, warnings: [] };
  const currency = typeof result.currency === 'string' ? result.currency : 'EUR';
  const fields = Object.keys(FIELD_LABELS)
    .filter((key) => typeof result[key] === 'string' || typeof result[key] === 'number')
    .map((key) => {
      const raw = result[key] as string | number;
      const value =
        AMOUNTS.has(key) && typeof raw === 'number'
          ? raw.toLocaleString('it-IT', { style: 'currency', currency })
          : typeof raw === 'string' && ISO_DATE.test(raw)
            ? raw.split('-').reverse().join('/')
            : String(raw);
      return { label: FIELD_LABELS[key], value };
    });
  const type = typeof result.documentType === 'string' ? result.documentType : null;
  return {
    documentType: type ? (DOCUMENT_TYPES[type] ?? type) : null,
    fields,
    reviewRequired: result.reviewRequired === true,
    warnings: Array.isArray(result.warnings)
      ? result.warnings.filter((w): w is string => typeof w === 'string')
      : [],
  };
}

/** The type of a practice in Italian (the API label is in English). */
export function kindLabel(practice: Pick<Practice, 'kind' | 'typeLabel'>): string {
  return KIND_LABELS[practice.kind] ?? practice.typeLabel;
}

/** The summary, unless it only repeats the name («pratica <nome>»). */
export function usefulSummary(practice: Pick<Practice, 'name' | 'summary'>): string | null {
  const summary = practice.summary.trim();
  if (!summary || summary.toLowerCase() === `pratica ${practice.name}`.toLowerCase()) return null;
  return summary;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
