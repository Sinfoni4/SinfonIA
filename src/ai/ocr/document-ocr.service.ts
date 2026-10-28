import {
  CertificateOcrSchema,
  DeliveryNoteOcrSchema,
  GenericDocumentOcrSchema,
  InvoiceOcrSchema,
  ReceiptOcrSchema,
  type CertificateCategory,
  type DocumentOcrResult,
} from './ocr.types.js';
import {
  DocumentTextExtractor,
  TesseractOcrEngine,
  detectFileKind,
  type DetectedFileKind,
  type OcrEngine,
} from './text-extraction.js';

export class UnsupportedDocumentError extends Error {
  constructor() {
    super('Unsupported document format: allowed formats are PDF, JPEG, PNG, WEBP and plain text');
    this.name = 'UnsupportedDocumentError';
  }
}

export interface DocumentOcrServiceOptions {
  /** OCR engine for images and scanned PDFs; defaults to the in-process Tesseract engine. */
  ocrEngine?: OcrEngine;
  maxOcrPdfPages?: number;
  /** Below this mean OCR confidence (0-100) the result is flagged for human review. */
  minOcrConfidence?: number;
}

const DATE_PATTERN = String.raw`(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})`;
// Italian amounts: "1.525,61", "45,80", "1.200" (thousands only) or plain "1250.50".
const AMOUNT_PATTERN = String.raw`(\d{1,3}(?:\.\d{3})*,\d{1,2}|\d{1,3}(?:\.\d{3})+(?!\d)|\d+(?:[.,]\d{1,2})?)`;
// "IVA" as a tax amount, not as part of "P.IVA" / "Partita IVA".
const VAT_AMOUNT_REGEX = new RegExp(
  String.raw`(?<!p\.\s?|partita\s)\b(?:iva|imposta)\b(?:\s*\(?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*\)?)?\s*[:.]?\s*€?\s*` +
    AMOUNT_PATTERN,
  'i',
);
const VAT_NUMBER_REGEX = /(?:p\.?\s*iva|partita\s*iva|vat)\s*[:.]?\s*((?:IT)?\s?\d{11})\b/i;
const LEGAL_FORM_REGEX =
  /\b(?:s\.?\s?r\.?\s?l\.?|s\.?\s?p\.?\s?a\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|soc\.?\s*coop)(?![a-z])/i;

export class DocumentOcrService {
  private readonly ocrEngine: OcrEngine;
  private readonly extractor: DocumentTextExtractor;
  private readonly minOcrConfidence: number;

  constructor(options: DocumentOcrServiceOptions = {}) {
    this.ocrEngine = options.ocrEngine ?? new TesseractOcrEngine();
    this.extractor = new DocumentTextExtractor({
      ocrEngine: this.ocrEngine,
      maxOcrPdfPages: options.maxOcrPdfPages,
    });
    this.minOcrConfidence = options.minOcrConfidence ?? 70;
  }

  /**
   * Document AI pipeline: detects the real file type from its content, extracts the text
   * (PDF text layer or in-process OCR) and parses invoices, delivery notes (DDT), receipts
   * and certificates. Throws UnsupportedDocumentError for any other format.
   */
  async processDocument(
    content: Buffer | Uint8Array,
    _mimeType: string,
    fileName: string,
    hint?: string,
  ): Promise<DocumentOcrResult> {
    const buffer = Buffer.from(content);
    const kind = detectFileKind(buffer);
    if (!kind) {
      throw new UnsupportedDocumentError();
    }

    const extraction = await this.extractor.extract(buffer, kind);
    const result = this.parseDocumentText(extraction.text, fileName, hint);

    const lowConfidence =
      typeof extraction.confidence === 'number' && extraction.confidence < this.minOcrConfidence;
    const warnings = lowConfidence
      ? [...result.warnings, `Low OCR confidence (${Math.round(extraction.confidence ?? 0)}%)`]
      : result.warnings;

    return {
      ...result,
      warnings,
      reviewRequired: result.reviewRequired || lowConfidence,
      extraction: {
        source: extraction.source,
        pages: extraction.pages,
        confidence:
          typeof extraction.confidence === 'number'
            ? Math.round(extraction.confidence * 10) / 10
            : null,
      },
    };
  }

  detectFileKind(content: Buffer | Uint8Array): DetectedFileKind | null {
    return detectFileKind(Buffer.from(content));
  }

  async terminate(): Promise<void> {
    await this.ocrEngine.terminate();
  }

  parseDocumentText(text: string, fileName: string, hint?: string): DocumentOcrResult {
    const lower = text.toLowerCase();
    const hintLower = (hint ?? '').toLowerCase();
    const has = (...words: string[]) =>
      words.some((w) => lower.includes(w) || hintLower.includes(w));

    if (has('fattura', 'invoice')) {
      return this.parseInvoice(text);
    }
    if (has('ddt', 'd.d.t', 'documento di trasporto', 'bolla di consegna')) {
      return this.parseDeliveryNote(text);
    }
    if (has('scontrino', 'ricevuta fiscale', 'documento commerciale', 'ricevuta')) {
      return this.parseReceipt(text);
    }
    if (has('certificato', 'certificazione', 'attestato', 'durc')) {
      return this.parseCertificate(text);
    }

    return GenericDocumentOcrSchema.parse({
      documentType: 'generic',
      title: fileName,
      extractedText: text.slice(0, 2000),
      detectedKeywords: this.extractKeywords(text),
    });
  }

  private parseInvoice(text: string): DocumentOcrResult {
    const warnings: string[] = [];
    const supplierVat = this.findVatNumber(text, warnings);
    const supplierName =
      this.matchGroup(text, /(?:fornitore|cedente|emittente)\s*[:.]?\s*([^\n\r]+)/i) ??
      this.findCompanyLine(text);
    const documentNumber = this.matchGroup(
      text,
      /fattura\s*(?:n[°º.]?|num(?:ero)?)\s*[:.]?\s*([a-z0-9][a-z0-9/-]*)/i,
    );
    const documentDate = this.findDate(text, /(?:data(?:\s+documento)?)\s*[:.]?\s*/i);

    const totalAmount = this.findAmount(
      text,
      /totale\s*(?:fattura|documento|da\s+pagare|eur(?:o)?|€)?\s*[:.]?\s*€?\s*/i,
    );
    let taxableAmount = this.findAmount(text, /(?:imponibile|netto\s*merce)\s*[:.]?\s*€?\s*/i);
    const vatMatch = text.match(VAT_AMOUNT_REGEX);
    let vatAmount = vatMatch?.[2] ? this.parseNumber(vatMatch[2]) : null;
    let vatRate = vatMatch?.[1] ? this.parseNumber(vatMatch[1]) : null;

    // Only arithmetic derivations from values actually read on the document.
    if (vatAmount === null && totalAmount !== null && taxableAmount !== null) {
      vatAmount = this.round(totalAmount - taxableAmount);
    }
    if (taxableAmount === null && totalAmount !== null && vatAmount !== null) {
      taxableAmount = this.round(totalAmount - vatAmount);
    }
    if (vatRate === null && taxableAmount && vatAmount !== null) {
      vatRate = Math.round((vatAmount / taxableAmount) * 100);
    }
    if (
      totalAmount !== null &&
      taxableAmount !== null &&
      vatAmount !== null &&
      Math.abs(taxableAmount + vatAmount - totalAmount) > 0.02
    ) {
      warnings.push('Totals do not add up: taxable amount + VAT differs from document total');
    }

    const fields = {
      supplierName,
      supplierVat,
      documentDate,
      documentNumber,
      taxableAmount,
      vatRate,
      vatAmount,
      totalAmount,
    };
    return InvoiceOcrSchema.parse({
      documentType: 'invoice',
      ...fields,
      items: this.findInvoiceItems(text),
      ...this.reviewInfo(fields, warnings),
    });
  }

  private parseDeliveryNote(text: string): DocumentOcrResult {
    const warnings: string[] = [];
    const fields = {
      supplierName: this.matchGroup(text, /(?:mittente|fornitore|cedente)\s*[:.]?\s*([^\n\r]+)/i),
      supplierVat: this.findVatNumber(text, warnings),
      documentDate: this.findDate(text, /(?:data(?:\s+documento)?)\s*[:.]?\s*/i),
      documentNumber: this.matchGroup(
        text,
        /(?:d\.?d\.?t\.?|documento\s*di\s*trasporto|bolla)\s*(?:n[°º.]?|num(?:ero)?)\s*[:.]?\s*([a-z0-9][a-z0-9/-]*)/i,
      ),
      recipientName: this.matchGroup(
        text,
        /(?:destinatario|cessionario|consegnare\s*a)\s*[:.]?\s*([^\n\r]+)/i,
      ),
    };
    const carrierName = this.matchGroup(text, /vettore\s*[:.]?\s*([^\n\r]+)/i);

    return DeliveryNoteOcrSchema.parse({
      documentType: 'delivery_note',
      ...fields,
      ...(carrierName ? { carrierName } : {}),
      items: this.findDeliveryItems(text),
      ...this.reviewInfo(fields, warnings),
    });
  }

  private parseReceipt(text: string): DocumentOcrResult {
    const warnings: string[] = [];
    const firstLine = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /[a-z]{3,}/i.test(l));
    // OCR often adds a stray lowercase character after an all-caps shop sign ("BAR ESEMPIO i").
    const merchantLine = firstLine?.replace(/^([^a-z]+?)\s+[a-z]$/, '$1');
    const fields = {
      merchantName: merchantLine ? this.cleanValue(merchantLine) : null,
      merchantVat: this.findVatNumber(text, warnings),
      documentDate: this.findDate(text, /(?:data)\s*[:.]?\s*/i),
      totalAmount: this.findAmount(text, /totale\s*(?:complessivo|eur(?:o)?|€)?\s*[:.]?\s*€?\s*/i),
    };
    return ReceiptOcrSchema.parse({
      documentType: 'receipt',
      ...fields,
      ...this.reviewInfo(fields, warnings),
    });
  }

  private parseCertificate(text: string): DocumentOcrResult {
    const titleLine = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /certificat|attestat|durc/i.test(l));
    const fields = {
      title: titleLine ? this.cleanValue(titleLine) : null,
      issuer: this.matchGroup(
        text,
        /(?:organismo\s+di\s+controllo|ente\s+certificatore|rilasciato\s+da|emesso\s+da)\s*[:.]?\s*([^\n\r]+)/i,
      ),
      holderName: this.matchGroup(
        text,
        /(?:operatore|intestatario|titolare|impresa|ragione\s+sociale|lavoratore)\s*[:.]?\s*([^\n\r]+)/i,
      ),
      certificateNumber: this.matchGroup(
        text,
        /(?:certificato|attestato|protocollo|codice)\s*(?:n[°º.]?|num(?:ero)?)\s*[:.]?\s*([a-z0-9][a-z0-9/-]*)/i,
      ),
      issueDate: this.findDate(
        text,
        /(?:emissione|emesso\s+il|rilasciato\s+il|rilascio)\s*[:.]?\s*/i,
      ),
      expiryDate: this.findDate(
        text,
        /(?:scadenza|scade\s+il|valido\s+fino\s+al|validit[àa]\s+fino\s+al)\s*[:.]?\s*/i,
      ),
    };
    return CertificateOcrSchema.parse({
      documentType: 'certificate',
      category: this.detectCertificateCategory(text),
      ...fields,
      ...this.reviewInfo(fields, []),
    });
  }

  private detectCertificateCategory(text: string): CertificateCategory {
    if (/biologic|\bbio\b/i.test(text)) return 'BIO';
    if (/durc|regolarit[àa]\s+contributiva/i.test(text)) return 'DURC';
    if (/sicurezza|d\.?\s?lgs\.?\s*81/i.test(text)) return 'SICUREZZA_LAVORO';
    if (/visita\s+medica|idoneit[àa]/i.test(text)) return 'VISITA_MEDICA';
    if (/patentino|abilitazione/i.test(text)) return 'PATENTINO';
    return 'ALTRO';
  }

  private reviewInfo(
    fields: Record<string, unknown>,
    warnings: string[],
  ): { missingFields: string[]; warnings: string[]; reviewRequired: boolean } {
    const missingFields = Object.entries(fields)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    return {
      missingFields,
      warnings,
      reviewRequired: missingFields.length > 0 || warnings.length > 0,
    };
  }

  private findVatNumber(text: string, warnings: string[]): string | null {
    const raw = text.match(VAT_NUMBER_REGEX)?.[1];
    if (!raw) return null;
    const vat = raw.replace(/\s/g, '').toUpperCase();
    if (!isValidItalianVat(vat.replace(/^IT/, ''))) {
      warnings.push(`VAT number ${vat} fails the check digit`);
    }
    return vat;
  }

  private findCompanyLine(text: string): string | null {
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => LEGAL_FORM_REGEX.test(l) && !/^(?:cliente|destinatario|spett)/i.test(l));
    return line ? this.cleanValue(line) : null;
  }

  /** Prefers a date right after a label; falls back to the first date in the text. */
  private findDate(text: string, label: RegExp): string | null {
    const labeled = text.match(new RegExp(label.source + DATE_PATTERN, 'i'))?.[1];
    const raw = labeled ?? text.match(new RegExp(DATE_PATTERN))?.[1];
    return raw ? this.normalizeDate(raw) : null;
  }

  private findAmount(text: string, label: RegExp): number | null {
    const raw = text.match(new RegExp(label.source + AMOUNT_PATTERN, 'i'))?.[1];
    return raw ? this.parseNumber(raw) : null;
  }

  private findInvoiceItems(text: string) {
    const itemRegex = new RegExp(
      String.raw`^(.+?)\s+([\d.,]+)\s*[x×]\s*€?\s*${AMOUNT_PATTERN}\s*=\s*€?\s*${AMOUNT_PATTERN}\s*$`,
      'i',
    );
    return text.split(/\r?\n/).flatMap((line) => {
      const m = line.trim().match(itemRegex);
      if (!m?.[1] || !m[2] || !m[3] || !m[4]) return [];
      const quantity = this.parseNumber(m[2]);
      if (quantity <= 0) return [];
      return [
        {
          description: this.cleanValue(m[1].replace(/\s+(?:kg|pz|lt|l|n\.?)$/i, '')),
          quantity,
          unitPrice: this.parseNumber(m[3]),
          total: this.parseNumber(m[4]),
        },
      ];
    });
  }

  private findDeliveryItems(text: string) {
    const itemRegex =
      /^(?:[-*•]|\d+[.)])\s*(.+?)\s*[-:]?\s*(?:(?:quantit[àa]|q\.?t[àa]|qta|x)\s*[:.]?\s*)?(\d+(?:[.,]\d+)?)\s*(pz|colli|bt|kg|ct|lt)?\s*$/i;
    return text.split(/\r?\n/).flatMap((line) => {
      const m = line.trim().match(itemRegex);
      if (!m?.[1] || !m[2]) return [];
      const quantity = this.parseNumber(m[2]);
      if (quantity <= 0) return [];
      return [
        {
          description: this.cleanValue(m[1].replace(/[-:]$/, '')),
          quantity,
          unitOfMeasure: (m[3] ?? 'PZ').toUpperCase(),
        },
      ];
    });
  }

  private matchGroup(text: string, regex: RegExp): string | null {
    const value = text.match(regex)?.[1];
    if (!value) return null;
    const cleaned = this.cleanValue(value);
    return cleaned.length > 0 ? cleaned : null;
  }

  /** Trims OCR noise such as trailing separators and isolated punctuation. */
  private cleanValue(raw: string): string {
    return raw
      .replace(/\s+[^\p{L}\p{N}\s]{1,2}$/u, '')
      .replace(/[\s,;:]+$/u, '')
      .trim();
  }

  private normalizeDate(raw: string): string | null {
    const parts = raw.split(/[-/.]/);
    if (parts.length !== 3) return null;
    const [a, b, c] = parts.map(Number) as [number, number, number];
    const [year, month, day] = String(parts[0]).length === 4 ? [a, b, c] : [c, b, a];

    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date.toISOString().slice(0, 10);
  }

  private parseNumber(raw: string): number {
    let clean = raw.trim().replace(/\s/g, '');
    if (clean.includes(',')) {
      // Italian format: dots are thousands separators, comma is the decimal separator.
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) {
      clean = clean.replace(/\./g, '');
    }
    const val = Number(clean);
    return Number.isNaN(val) ? 0 : this.round(val);
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4);
    return Array.from(new Set(words)).slice(0, 10);
  }
}

/** Italian VAT number (partita IVA) check digit. */
export function isValidItalianVat(vat: string): boolean {
  if (!/^\d{11}$/.test(vat)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = Number(vat[i]);
    if (i % 2 === 0) {
      sum += digit;
    } else {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return (10 - (sum % 10)) % 10 === Number(vat[10]);
}

export const defaultDocumentOcrService = new DocumentOcrService();
