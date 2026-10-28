import { createRequire } from 'node:module';
import path from 'node:path';

import { createWorker, OEM, type Worker } from 'tesseract.js';
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';

/**
 * Text extraction layer of the Document AI pipeline.
 * Everything runs in-process: no document content leaves the application perimeter.
 * - Images (JPEG, PNG, WEBP): Tesseract OCR with the bundled Italian model.
 * - PDF with a text layer: direct text extraction.
 * - Scanned PDF (no usable text layer): pages rendered to images, then OCR.
 * - Plain text: decoded as UTF-8.
 */

export type DetectedFileKind = 'pdf' | 'jpeg' | 'png' | 'webp' | 'text';

export type TextExtractionSource = 'plain_text' | 'pdf_text' | 'ocr_image' | 'ocr_pdf';

export interface TextExtractionResult {
  text: string;
  source: TextExtractionSource;
  pages: number;
  /** Mean OCR confidence 0-100; undefined when no OCR was needed. */
  confidence?: number;
}

export interface OcrEngine {
  recognize(image: Buffer): Promise<{ text: string; confidence: number }>;
  terminate(): Promise<void>;
}

// A PDF text layer shorter than this is treated as a scanned document.
const MIN_PDF_TEXT_CHARS = 30;

/**
 * Detects the real file type from its magic bytes. The declared MIME type is never trusted.
 * Returns null for unsupported or unrecognized content.
 */
export function detectFileKind(content: Buffer): DetectedFileKind | null {
  if (content.length >= 5 && content.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'jpeg';
  }
  if (
    content.length >= 8 &&
    content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString('latin1') === 'RIFF' &&
    content.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (isLikelyText(content)) return 'text';
  return null;
}

function isLikelyText(content: Buffer): boolean {
  if (content.length === 0) return false;
  const sample = content.subarray(0, 4096);
  if (sample.includes(0)) return false;
  const decoded = sample.toString('utf-8');
  // U+FFFD marks bytes that are not valid UTF-8.
  const invalid = (decoded.match(/�/g) ?? []).length;
  return invalid / decoded.length < 0.01;
}

/** Tesseract engine with a lazily created, reused worker and the bundled Italian model. */
export class TesseractOcrEngine implements OcrEngine {
  private worker: Promise<Worker> | null = null;

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      const require = createRequire(import.meta.url);
      const langPath = path.join(
        path.dirname(require.resolve('@tesseract.js-data/ita/package.json')),
        '4.0.0_best_int',
      );
      this.worker = createWorker('ita', OEM.LSTM_ONLY, {
        langPath,
        gzip: true,
        cacheMethod: 'none',
      });
      this.worker.catch(() => {
        this.worker = null;
      });
    }
    return this.worker;
  }

  async recognize(image: Buffer): Promise<{ text: string; confidence: number }> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(image);
    return { text: data.text, confidence: data.confidence };
  }

  async terminate(): Promise<void> {
    if (!this.worker) return;
    const worker = await this.worker;
    this.worker = null;
    await worker.terminate();
  }
}

export interface TextExtractorOptions {
  ocrEngine: OcrEngine;
  /** Maximum number of scanned PDF pages sent to OCR. */
  maxOcrPdfPages?: number;
}

export class DocumentTextExtractor {
  private readonly maxOcrPdfPages: number;

  constructor(private readonly options: TextExtractorOptions) {
    this.maxOcrPdfPages = options.maxOcrPdfPages ?? 5;
  }

  async extract(content: Buffer, kind: DetectedFileKind): Promise<TextExtractionResult> {
    switch (kind) {
      case 'text':
        return { text: content.toString('utf-8'), source: 'plain_text', pages: 1 };
      case 'jpeg':
      case 'png':
      case 'webp': {
        const ocr = await this.options.ocrEngine.recognize(content);
        return { text: ocr.text, source: 'ocr_image', pages: 1, confidence: ocr.confidence };
      }
      case 'pdf':
        return this.extractPdf(content);
    }
  }

  private async extractPdf(content: Buffer): Promise<TextExtractionResult> {
    // pdf.js may transfer (detach) the buffer it receives, so every call gets its own copy.
    const { totalPages, text } = await extractText(new Uint8Array(content), { mergePages: true });
    if (text.replace(/\s/g, '').length >= MIN_PDF_TEXT_CHARS) {
      return { text, source: 'pdf_text', pages: totalPages };
    }

    const pdf = await getDocumentProxy(new Uint8Array(content));
    const pageCount = Math.min(pdf.numPages, this.maxOcrPdfPages);
    const texts: string[] = [];
    const confidences: number[] = [];
    for (let page = 1; page <= pageCount; page++) {
      const png = await renderPageAsImage(new Uint8Array(content), page, {
        canvasImport: () => import('@napi-rs/canvas'),
        scale: 2,
      });
      const ocr = await this.options.ocrEngine.recognize(Buffer.from(png));
      texts.push(ocr.text);
      confidences.push(ocr.confidence);
    }

    const confidence = confidences.length
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0;
    return { text: texts.join('\n'), source: 'ocr_pdf', pages: pdf.numPages, confidence };
  }
}
