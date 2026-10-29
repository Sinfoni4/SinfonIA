import { createRequire } from 'node:module';
import path from 'node:path';

import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

import { DocumentWorker } from './document-worker.js';

import type { ImagePreprocessor, PdfExtractor } from './document-worker.js';

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
  /** True when the text comes from the preprocessed second read of a photo. */
  preprocessed?: boolean;
}

/** `block` reads the image as one uniform block of text, which suits receipts and slips. */
export type OcrLayout = 'auto' | 'block';

export interface OcrEngine {
  recognize(
    image: Buffer,
    options?: { layout?: OcrLayout },
  ): Promise<{ text: string; confidence: number }>;
  terminate(): Promise<void>;
}

// A PDF text layer shorter than this is treated as a scanned document.
const MIN_PDF_TEXT_CHARS = 30;
// Below this OCR confidence a photo is read a second time, preprocessed.
const SECOND_READ_CONFIDENCE = 70;

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
  private layout: OcrLayout = 'auto';
  // The layout is a worker-wide parameter: calls are serialized so that a read never runs with
  // the layout set by a concurrent one.
  private queue: Promise<unknown> = Promise.resolve();

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

  recognize(
    image: Buffer,
    options: { layout?: OcrLayout } = {},
  ): Promise<{ text: string; confidence: number }> {
    const run = this.queue.then(async () => {
      const worker = await this.getWorker();
      const layout = options.layout ?? 'auto';
      if (layout !== this.layout) {
        await worker.setParameters({
          tessedit_pageseg_mode: layout === 'block' ? PSM.SINGLE_BLOCK : PSM.AUTO,
        });
        this.layout = layout;
      }
      const { data } = await worker.recognize(image);
      return { text: data.text, confidence: data.confidence };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async terminate(): Promise<void> {
    if (!this.worker) return;
    const worker = await this.worker;
    this.worker = null;
    this.layout = 'auto';
    await worker.terminate();
  }
}

export interface TextExtractorOptions {
  ocrEngine: OcrEngine;
  /** Maximum number of scanned PDF pages sent to OCR. */
  maxOcrPdfPages?: number;
  /** PDF parsing, page rendering and image preprocessing, off the main thread by default. */
  documentWorker?: PdfExtractor & ImagePreprocessor;
}

// Values a business document is read for: dates, 11-digit VAT numbers, amounts with decimals.
const KEY_FACT_PATTERNS = [
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  /\b\d{11}\b/g,
  /\b\d{1,3}(?:[.\s]?\d{3})*,\d{2}\b/g,
];

/** How useful an OCR read is: key facts found first, then the engine's confidence. */
export function scoreOcrRead(read: { text: string; confidence: number }): number {
  const facts = KEY_FACT_PATTERNS.reduce(
    (count, pattern) => count + (read.text.match(pattern)?.length ?? 0),
    0,
  );
  return facts * 100 + read.confidence;
}

export class DocumentTextExtractor {
  private readonly maxOcrPdfPages: number;
  private readonly documentWorker: PdfExtractor & ImagePreprocessor;

  constructor(private readonly options: TextExtractorOptions) {
    this.maxOcrPdfPages = options.maxOcrPdfPages ?? 5;
    this.documentWorker = options.documentWorker ?? new DocumentWorker();
  }

  async extract(content: Buffer, kind: DetectedFileKind): Promise<TextExtractionResult> {
    switch (kind) {
      case 'text':
        return { text: content.toString('utf-8'), source: 'plain_text', pages: 1 };
      case 'jpeg':
      case 'png':
      case 'webp':
        return this.extractImage(content);
      case 'pdf':
        return this.extractPdf(content);
    }
  }

  /**
   * Photos are read as they are; a weak read (low confidence) is followed by a second one on a
   * preprocessed copy (enlarged, adaptive threshold, single text block), and the more useful of
   * the two is kept. A good photo costs one read, a poor one never ends up worse than before.
   */
  private async extractImage(content: Buffer): Promise<TextExtractionResult> {
    const first = await this.options.ocrEngine.recognize(content);
    if (first.confidence >= SECOND_READ_CONFIDENCE) {
      return { text: first.text, source: 'ocr_image', pages: 1, confidence: first.confidence };
    }

    const cleaned = await this.documentWorker.preprocess(content);
    const second = await this.options.ocrEngine.recognize(cleaned, { layout: 'block' });
    const best = scoreOcrRead(second) > scoreOcrRead(first) ? second : first;
    return {
      text: best.text,
      source: 'ocr_image',
      pages: 1,
      confidence: best.confidence,
      ...(best === second ? { preprocessed: true } : {}),
    };
  }

  private async extractPdf(content: Buffer): Promise<TextExtractionResult> {
    const pdf = await this.documentWorker.extract(content, {
      maxPages: this.maxOcrPdfPages,
      minTextChars: MIN_PDF_TEXT_CHARS,
    });
    if (pdf.text !== null) {
      return { text: pdf.text, source: 'pdf_text', pages: pdf.totalPages };
    }

    const texts: string[] = [];
    const confidences: number[] = [];
    for (const image of pdf.images) {
      const ocr = await this.options.ocrEngine.recognize(image);
      texts.push(ocr.text);
      confidences.push(ocr.confidence);
    }

    const confidence = confidences.length
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0;
    return { text: texts.join('\n'), source: 'ocr_pdf', pages: pdf.totalPages, confidence };
  }

  /** Stops the document worker; the OCR engine is owned and terminated by the caller. */
  async terminate(): Promise<void> {
    await this.documentWorker.terminate();
  }
}
