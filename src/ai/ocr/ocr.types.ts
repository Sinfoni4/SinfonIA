import { z } from 'zod';

// Fields that cannot be read from the document are null and listed in `missingFields`:
// the extractor never invents values. `reviewRequired` asks a human to check the result.

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

export const ExtractionMetaSchema = z.object({
  source: z.enum(['plain_text', 'pdf_text', 'ocr_image', 'ocr_pdf']),
  pages: z.number().int().nonnegative(),
  /** Mean OCR confidence 0-100; null when no OCR was needed. */
  confidence: z.number().min(0).max(100).nullable(),
});

const ResultBaseSchema = z.object({
  missingFields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  reviewRequired: z.boolean().default(false),
  extraction: ExtractionMetaSchema.optional(),
});

export const InvoiceItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export const InvoiceOcrSchema = ResultBaseSchema.extend({
  documentType: z.literal('invoice'),
  supplierName: z.string().min(1).nullable(),
  supplierVat: z.string().min(8).nullable(),
  documentDate: IsoDateSchema.nullable(),
  documentNumber: z.string().min(1).nullable(),
  taxableAmount: z.number().nonnegative().nullable(),
  vatRate: z.number().nonnegative().nullable(),
  vatAmount: z.number().nonnegative().nullable(),
  // Zero is valid (non-fiscal slips, free items) and flagged for review by the parser.
  totalAmount: z.number().nonnegative().nullable(),
  currency: z.string().default('EUR'),
  items: z.array(InvoiceItemSchema).default([]),
});

export const DeliveryNoteItemSchema = z.object({
  itemCode: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitOfMeasure: z.string().optional().default('PZ'),
});

export const DeliveryNoteOcrSchema = ResultBaseSchema.extend({
  documentType: z.literal('delivery_note'),
  supplierName: z.string().min(1).nullable(),
  supplierVat: z.string().min(8).nullable(),
  documentDate: IsoDateSchema.nullable(),
  documentNumber: z.string().min(1).nullable(),
  recipientName: z.string().min(1).nullable(),
  destinationAddress: z.string().optional(),
  carrierName: z.string().optional(),
  items: z.array(DeliveryNoteItemSchema).default([]),
});

export const ReceiptOcrSchema = ResultBaseSchema.extend({
  documentType: z.literal('receipt'),
  merchantName: z.string().min(1).nullable(),
  merchantVat: z.string().min(8).nullable(),
  documentDate: IsoDateSchema.nullable(),
  // Zero is valid (non-fiscal slips, free items) and flagged for review by the parser.
  totalAmount: z.number().nonnegative().nullable(),
  vatAmount: z.number().nonnegative().optional(),
  currency: z.string().default('EUR'),
});

// Categories aligned with the compliance deadline model planned for the scheduler (Phase 3C).
export const CertificateCategorySchema = z.enum([
  'BIO',
  'DURC',
  'SICUREZZA_LAVORO',
  'VISITA_MEDICA',
  'PATENTINO',
  'ALTRO',
]);

export const CertificateOcrSchema = ResultBaseSchema.extend({
  documentType: z.literal('certificate'),
  category: CertificateCategorySchema,
  title: z.string().min(1).nullable(),
  issuer: z.string().min(1).nullable(),
  holderName: z.string().min(1).nullable(),
  certificateNumber: z.string().min(1).nullable(),
  issueDate: IsoDateSchema.nullable(),
  expiryDate: IsoDateSchema.nullable(),
});

export const GenericDocumentOcrSchema = ResultBaseSchema.extend({
  documentType: z.literal('generic'),
  title: z.string().min(1),
  extractedText: z.string(),
  detectedKeywords: z.array(z.string()).default([]),
});

export const DocumentOcrResultSchema = z.discriminatedUnion('documentType', [
  InvoiceOcrSchema,
  DeliveryNoteOcrSchema,
  ReceiptOcrSchema,
  CertificateOcrSchema,
  GenericDocumentOcrSchema,
]);

export type ExtractionMeta = z.infer<typeof ExtractionMetaSchema>;
export type InvoiceOcr = z.infer<typeof InvoiceOcrSchema>;
export type DeliveryNoteOcr = z.infer<typeof DeliveryNoteOcrSchema>;
export type ReceiptOcr = z.infer<typeof ReceiptOcrSchema>;
export type CertificateCategory = z.infer<typeof CertificateCategorySchema>;
export type CertificateOcr = z.infer<typeof CertificateOcrSchema>;
export type GenericDocumentOcr = z.infer<typeof GenericDocumentOcrSchema>;
export type DocumentOcrResult = z.infer<typeof DocumentOcrResultSchema>;
