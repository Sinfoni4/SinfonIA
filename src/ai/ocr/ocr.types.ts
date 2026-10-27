import { z } from 'zod';

export const InvoiceItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export const InvoiceOcrSchema = z.object({
  documentType: z.literal('invoice'),
  supplierName: z.string().min(1),
  supplierVat: z.string().min(8),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  documentNumber: z.string().min(1),
  taxableAmount: z.number().nonnegative(),
  vatRate: z.number().nonnegative().default(22),
  vatAmount: z.number().nonnegative(),
  totalAmount: z.number().positive(),
  currency: z.string().default('EUR'),
  items: z.array(InvoiceItemSchema).optional().default([]),
});

export const DeliveryNoteItemSchema = z.object({
  itemCode: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitOfMeasure: z.string().optional().default('PZ'),
});

export const DeliveryNoteOcrSchema = z.object({
  documentType: z.literal('delivery_note'),
  supplierName: z.string().min(1),
  supplierVat: z.string().min(8),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  documentNumber: z.string().min(1),
  recipientName: z.string().min(1),
  destinationAddress: z.string().optional(),
  carrierName: z.string().optional(),
  items: z.array(DeliveryNoteItemSchema).min(1),
});

export const ReceiptOcrSchema = z.object({
  documentType: z.literal('receipt'),
  merchantName: z.string().min(1),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  totalAmount: z.number().positive(),
  vatAmount: z.number().nonnegative().optional(),
  currency: z.string().default('EUR'),
});

export const GenericDocumentOcrSchema = z.object({
  documentType: z.literal('generic'),
  title: z.string().min(1),
  extractedText: z.string(),
  detectedKeywords: z.array(z.string()).default([]),
});

export const DocumentOcrResultSchema = z.discriminatedUnion('documentType', [
  InvoiceOcrSchema,
  DeliveryNoteOcrSchema,
  ReceiptOcrSchema,
  GenericDocumentOcrSchema,
]);

export type InvoiceOcr = z.infer<typeof InvoiceOcrSchema>;
export type DeliveryNoteOcr = z.infer<typeof DeliveryNoteOcrSchema>;
export type ReceiptOcr = z.infer<typeof ReceiptOcrSchema>;
export type GenericDocumentOcr = z.infer<typeof GenericDocumentOcrSchema>;
export type DocumentOcrResult = z.infer<typeof DocumentOcrResultSchema>;
