import { afterAll, describe, expect, it, vi } from 'vitest';

import { DocumentOcrService } from '../src/ai/ocr/document-ocr.service.js';
import { DocumentWorker } from '../src/ai/ocr/document-worker.js';
import { DocumentTextExtractor, scoreOcrRead } from '../src/ai/ocr/text-extraction.js';

import type { ImagePreprocessor, PdfExtractor } from '../src/ai/ocr/document-worker.js';
import type { ReceiptOcr } from '../src/ai/ocr/ocr.types.js';
import type { OcrEngine } from '../src/ai/ocr/text-extraction.js';

// Cases found on a real crumpled thermal receipt photographed and sent through Telegram
// (Brico io "documento gestionale", 28/10/2026). The photo itself stays out of the repository.

describe('OCR second read on weak photos', () => {
  function setup(
    first: { text: string; confidence: number },
    second: { text: string; confidence: number },
  ) {
    const recognize = vi.fn((_image: Buffer, options?: { layout?: string }) =>
      Promise.resolve(options?.layout === 'block' ? second : first),
    );
    const preprocess = vi.fn(() => Promise.resolve(Buffer.from('clean')));
    const ocrEngine: OcrEngine = { recognize, terminate: () => Promise.resolve() };
    const documentWorker = {
      preprocess,
      extract: vi.fn(),
      terminate: () => Promise.resolve(),
    } as unknown as PdfExtractor & ImagePreprocessor;
    return {
      extractor: new DocumentTextExtractor({ ocrEngine, documentWorker }),
      recognize,
      preprocess,
    };
  }

  it('reads a good photo once', async () => {
    const { extractor, preprocess } = setup(
      { text: 'Totale 10,00', confidence: 91 },
      { text: '', confidence: 0 },
    );
    const result = await extractor.extract(Buffer.from('img'), 'jpeg');
    expect(preprocess).not.toHaveBeenCalled();
    expect(result).toMatchObject({ confidence: 91 });
    expect(result.preprocessed).toBeUndefined();
  });

  it('keeps the preprocessed read when it finds more key values', async () => {
    const { extractor, recognize } = setup(
      { text: 'bia È Pra I VE', confidence: 34 },
      { text: 'Partira Iva 08589490153 DATA : 07/12/2024 TOTALE : 0,00 EUR', confidence: 35 },
    );
    const result = await extractor.extract(Buffer.from('img'), 'jpeg');
    expect(recognize).toHaveBeenLastCalledWith(Buffer.from('clean'), { layout: 'block' });
    expect(result).toMatchObject({ preprocessed: true, confidence: 35 });
    expect(result.text).toContain('08589490153');
  });

  it('keeps the first read when the preprocessed one is not better', async () => {
    const { extractor } = setup(
      { text: 'Data 07/12/2024 Totale 12,50', confidence: 60 },
      { text: 'rumore', confidence: 65 },
    );
    const result = await extractor.extract(Buffer.from('img'), 'jpeg');
    expect(result.text).toContain('12,50');
    expect(result.preprocessed).toBeUndefined();
  });

  it('scores key values above raw confidence', () => {
    expect(scoreOcrRead({ text: '07/12/2024 08589490153 0,00', confidence: 30 })).toBeGreaterThan(
      scoreOcrRead({ text: 'testo pulito senza dati', confidence: 95 }),
    );
  });
});

describe('image preprocessing in the document worker', () => {
  const worker = new DocumentWorker();

  afterAll(async () => {
    await worker.terminate();
  });

  it('returns an enlarged black-and-white PNG for a small photo', async () => {
    const { readFileSync } = await import('node:fs');
    const { loadImage } = await import('@napi-rs/canvas');
    const photo = readFileSync('tests/fixtures/ocr/receipt-photo.jpg');
    const original = await loadImage(photo);

    const cleaned = await worker.preprocess(photo);
    expect(cleaned.subarray(0, 4).toString('hex')).toBe('89504e47');
    const image = await loadImage(cleaned);
    expect(image.width).toBe(original.width * 2);
  });
});

describe('parsing of real-world receipts', () => {
  const service = new DocumentOcrService();
  const receipt = (text: string) => service.parseDocumentText(text, 'scontrino.jpg') as ReceiptOcr;

  it('accepts a zero total and asks for review instead of failing', () => {
    const result = receipt(
      'Brico io S.p.A.\nPartita Iva 08589490153\nDOCUMENTO GESTIONALE\nSCONTRINO : 59\nDATA : 07/12/2024 TOTALE : 0,00 EUR',
    );
    expect(result.documentType).toBe('receipt');
    expect(result.totalAmount).toBe(0);
    expect(result.reviewRequired).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/total is zero/i);
  });

  it('finds a VAT number whose label OCR garbled, and flags it', () => {
    const result = receipt('Brico io S.p.A.\nPartira Iva 08589490153\nSCONTRINO\nTOTALE 12,50');
    expect(result.merchantVat).toBe('08589490153');
    expect(result.warnings.join(' ')).toMatch(/without its label/);
  });

  it('does not guess between two unlabeled VAT numbers', () => {
    const result = receipt('SCONTRINO\n08589490153\n01122334459\nTOTALE 12,50');
    expect(result.merchantVat).toBeNull();
  });

  it('prefers the company line and strips OCR noise around it', () => {
    const result = receipt(
      '| din logo\n| Brico io SpA"\nPartita Iva 08589490153\nSCONTRINO\nTOTALE 12,50',
    );
    expect(result.merchantName).toBe('Brico io SpA');
  });
});

// Label variants found with the synthetic PDF set (scripts/generate-ocr-pdf-samples.ts).
describe('document labels as different suppliers write them', () => {
  const service = new DocumentOcrService();
  const parse = (text: string) =>
    service.parseDocumentText(text, 'doc.pdf') as Record<string, unknown>;
  const invoice = (header: string, totals = 'Totale documento: 1.220,00') =>
    parse(
      `ORTOFRUTTA COLLINA S.R.L.\nPartita IVA: 08589490153\n${header}\nImponibile: 1.000,00\nIVA 22%: 220,00\n${totals}`,
    );

  it.each([
    ['FATTURA N. 2026/101\nData: 01/02/2026', '2026/101'],
    ['Fattura nr. 2026/101 del 01/02/2026', '2026/101'],
    ['Fattura immediata n° 2026/101\nData 01.02.2026', '2026/101'],
    ['Numero documento: 2026/101\nData documento: 01/02/2026', '2026/101'],
  ])('reads the invoice number from "%s"', (header, number) => {
    expect(invoice(header).documentNumber).toBe(number);
  });

  it('never takes a label fragment without digits as the number', () => {
    expect(invoice('Fattura nr. del 01/02/2026').documentNumber).toBeNull();
  });

  it('reads "Netto a pagare" as the document total', () => {
    expect(invoice('FATTURA N. 7\nData: 01/02/2026', 'Netto a pagare: 1.220,00').totalAmount).toBe(
      1220,
    );
  });

  it.each([
    ['DOCUMENTO DI TRASPORTO\nDDT N. DDT-301\nData: 02/05/2026', 'DDT-301'],
    ['D.D.T.\nNumero: DDT-301\nData consegna: 02/05/2026', 'DDT-301'],
    ['DOCUMENTO DI TRASPORTO (D.P.R. 472/96)\nN. documento DDT-301 del 02/05/2026', 'DDT-301'],
  ])('reads the delivery note number from "%s"', (header, number) => {
    const result = parse(
      `${header}\nMittente: Sementi del Friuli S.r.].\nP.IVA 08589490153\nDestinatario: Cooperativa Demo`,
    );
    expect(result.documentType).toBe('delivery_note');
    expect(result.documentNumber).toBe(number);
    expect(result.supplierName).toBe('Sementi del Friuli S.r.l.');
  });
});
