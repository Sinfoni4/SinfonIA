import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import {
  DocumentOcrService,
  UnsupportedDocumentError,
  isValidItalianVat,
} from '../src/ai/ocr/document-ocr.service.js';
import { detectFileKind, type OcrEngine } from '../src/ai/ocr/text-extraction.js';
import { loadConfig } from '../src/config/config.js';
import { AttachmentRejectedError } from '../src/core/errors/attachment.errors.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { AttachmentRepository } from '../src/data/repositories/attachment.repository.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { formatAttachmentResult } from '../src/interface/telegram/attachment.formatter.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV } from './helpers/auth.js';

import type { ContextService } from '../src/ai/context/context.service.js';
import type {
  CertificateOcr,
  DeliveryNoteOcr,
  InvoiceOcr,
  ReceiptOcr,
} from '../src/ai/ocr/ocr.types.js';
import type { PrismaClient } from '@prisma/client';

const FIXTURES = path.resolve(process.cwd(), 'tests', 'fixtures', 'ocr');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

// Real OCR runs in-process with Tesseract: allow time for the first worker start.
const OCR_TIMEOUT = 60_000;

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';
const practiceId = '44444444-4444-4444-8444-444444444444';

class FixedOcrEngine implements OcrEngine {
  constructor(
    private readonly text: string,
    private readonly confidence: number,
  ) {}
  recognize() {
    return Promise.resolve({ text: this.text, confidence: this.confidence });
  }
  terminate() {
    return Promise.resolve();
  }
}

function mockPrismaForAttachments() {
  let payload: Record<string, unknown> = { name: 'Pratica OCR', kind: 'generic', schemaVersion: 1 };
  const createAttachment = vi
    .fn()
    .mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'att-1', ...args.data, createdAt: new Date(), updatedAt: new Date() }),
    );
  const prisma = {
    practice: {
      findFirst: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: practiceId,
          tenantId,
          userId,
          status: 'CREATED',
          version: 1,
          payload,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
      updateMany: vi.fn().mockImplementation((args: { data: { payload: unknown } }) => {
        payload = args.data.payload as Record<string, unknown>;
        return Promise.resolve({ count: 1 });
      }),
    },
    practiceAttachment: { create: createAttachment },
  } as unknown as PrismaClient;
  return { prisma, createAttachment };
}

describe('Document AI: file type detection', () => {
  it('detects formats from magic bytes, ignoring file names and declared MIME types', () => {
    expect(detectFileKind(fixture('invoice-digital.pdf'))).toBe('pdf');
    expect(detectFileKind(fixture('invoice-photo.jpg'))).toBe('jpeg');
    expect(detectFileKind(fixture('invoice.png'))).toBe('png');
    expect(
      detectFileKind(
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
      ),
    ).toBe('webp');
    expect(detectFileKind(Buffer.from('Fattura n. 12 — totale 10,00 €'))).toBe('text');
  });

  it('rejects binary content that is not a supported document', () => {
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xff, 0xfe]);
    expect(detectFileKind(exe)).toBeNull();
    expect(detectFileKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('Document AI: real OCR on image and PDF fixtures', () => {
  const service = new DocumentOcrService();

  afterAll(async () => {
    await service.terminate();
  });

  const expectInvoice = (result: InvoiceOcr) => {
    expect(result.documentType).toBe('invoice');
    expect(result.supplierName).toMatch(/agricola esempio/i);
    expect(result.supplierVat).toBe('IT01234567897');
    expect(result.documentNumber).toBe('2026/118');
    expect(result.documentDate).toBe('2026-10-15');
    expect(result.taxableAmount).toBe(1250.5);
    expect(result.vatRate).toBe(22);
    expect(result.vatAmount).toBe(275.11);
    expect(result.totalAmount).toBe(1525.61);
    expect(result.items).toEqual([
      { description: 'Mele Golden', quantity: 500, unitPrice: 1.5, total: 750 },
      { description: 'Pere Williams', quantity: 250, unitPrice: 2, total: 500.5 },
    ]);
    expect(result.missingFields).toEqual([]);
    expect(result.reviewRequired).toBe(false);
  };

  it(
    'reads a clean invoice image (PNG)',
    async () => {
      const result = await service.processDocument(fixture('invoice.png'), 'image/png', 'f.png');
      expectInvoice(result as InvoiceOcr);
      expect(result.extraction?.source).toBe('ocr_image');
      expect(result.extraction?.confidence).toBeGreaterThan(70);
    },
    OCR_TIMEOUT,
  );

  it(
    'reads a smartphone-style invoice photo (tilted, noisy JPEG)',
    async () => {
      const result = await service.processDocument(
        fixture('invoice-photo.jpg'),
        'image/jpeg',
        'foto.jpg',
      );
      expectInvoice(result as InvoiceOcr);
      expect(result.extraction?.source).toBe('ocr_image');
    },
    OCR_TIMEOUT,
  );

  it(
    'reads a digital PDF invoice from its text layer without OCR',
    async () => {
      const result = await service.processDocument(
        fixture('invoice-digital.pdf'),
        'application/pdf',
        'fattura.pdf',
      );
      expectInvoice(result as InvoiceOcr);
      expect(result.extraction).toEqual({ source: 'pdf_text', pages: 1, confidence: null });
    },
    OCR_TIMEOUT,
  );

  it.each([
    ['ddt-photo.jpg', 'ocr_image'],
    ['ddt-scanned.pdf', 'ocr_pdf'],
  ])(
    'reads a delivery note (%s)',
    async (file, source) => {
      const result = (await service.processDocument(
        fixture(file),
        'application/octet-stream',
        file,
      )) as DeliveryNoteOcr;
      expect(result.documentType).toBe('delivery_note');
      expect(result.supplierName).toBe('Cantina Esempio S.r.l.');
      expect(result.supplierVat).toBe('09876543217');
      expect(result.documentNumber).toBe('2026-088');
      expect(result.documentDate).toBe('2026-10-20');
      expect(result.recipientName).toBe('Cooperativa Demo');
      expect(result.items).toEqual([
        { description: 'Vino Rosso DOC', quantity: 24, unitOfMeasure: 'PZ' },
        { description: 'Vino Bianco IGT', quantity: 12, unitOfMeasure: 'PZ' },
      ]);
      expect(result.extraction?.source).toBe(source);
      expect(result.reviewRequired).toBe(false);
    },
    OCR_TIMEOUT,
  );

  it(
    'reads a receipt photo without mistaking the VAT number for the VAT amount',
    async () => {
      const result = (await service.processDocument(
        fixture('receipt-photo.jpg'),
        'image/jpeg',
        'scontrino.jpg',
      )) as ReceiptOcr;
      expect(result.documentType).toBe('receipt');
      expect(result.merchantName).toBe('BAR ESEMPIO');
      expect(result.merchantVat).toBe('01122334459');
      expect(result.documentDate).toBe('2026-10-25');
      expect(result.totalAmount).toBe(45.8);
      expect(result.vatAmount).toBeUndefined();
    },
    OCR_TIMEOUT,
  );

  it(
    'reads a certificate with category and expiry date',
    async () => {
      const result = (await service.processDocument(
        fixture('certificate.png'),
        'image/png',
        'certificato.png',
      )) as CertificateOcr;
      expect(result.documentType).toBe('certificate');
      expect(result.category).toBe('BIO');
      expect(result.issuer).toBe('Ente Certificatore Esempio');
      expect(result.holderName).toBe('Agricola Esempio S.r.l.');
      expect(result.certificateNumber).toBe('BIO-2026-0042');
      expect(result.issueDate).toBe('2026-03-01');
      expect(result.expiryDate).toBe('2027-02-28');
    },
    OCR_TIMEOUT,
  );

  it('throws UnsupportedDocumentError for unsupported binary content', async () => {
    await expect(
      service.processDocument(Buffer.from([0x4d, 0x5a, 0x00, 0x01]), 'application/pdf', 'x.pdf'),
    ).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });
});

describe('Document AI: parsing never invents values', () => {
  const service = new DocumentOcrService({ ocrEngine: new FixedOcrEngine('', 0) });

  it('leaves unreadable invoice fields null and flags them for review', () => {
    const result = service.parseDocumentText('Fattura illeggibile', 'scan.jpg') as InvoiceOcr;
    expect(result.documentType).toBe('invoice');
    expect(result.supplierVat).toBeNull();
    expect(result.documentNumber).toBeNull();
    expect(result.documentDate).toBeNull();
    expect(result.totalAmount).toBeNull();
    expect(result.vatRate).toBeNull();
    expect(result.missingFields).toEqual(
      expect.arrayContaining(['supplierVat', 'documentNumber', 'documentDate', 'totalAmount']),
    );
    expect(result.reviewRequired).toBe(true);
  });

  it('rejects impossible dates instead of replacing them with today', () => {
    const result = service.parseDocumentText(
      'Scontrino\nData: 31/02/2026\nTOTALE EURO 10,00',
      'r.jpg',
    ) as ReceiptOcr;
    expect(result.documentDate).toBeNull();
    expect(result.missingFields).toContain('documentDate');
  });

  it('warns when the VAT number fails the check digit', () => {
    const result = service.parseDocumentText(
      'Fattura n. 1\nP.IVA 01234567890\nData: 01/10/2026\nTotale documento: 12,20',
      'f.txt',
    );
    expect(result.warnings.join(' ')).toMatch(/check digit/);
    expect(result.reviewRequired).toBe(true);
  });

  it('warns when taxable amount and VAT do not add up to the total', () => {
    const result = service.parseDocumentText(
      'Fattura n. 7\nImponibile: 100,00\nIVA 22%: 22,00\nTotale documento: 130,00',
      'f.txt',
    );
    expect(result.warnings.join(' ')).toMatch(/do not add up/);
  });

  it('validates Italian VAT check digits', () => {
    expect(isValidItalianVat('01234567897')).toBe(true);
    expect(isValidItalianVat('01234567890')).toBe(false);
    expect(isValidItalianVat('1234')).toBe(false);
  });

  it('flags low-confidence OCR results for human review', async () => {
    const lowConfidence = new DocumentOcrService({
      ocrEngine: new FixedOcrEngine(
        'Scontrino\nP.IVA 01122334459\nData: 25/10/2026\nTOTALE EURO 45,80',
        41,
      ),
    });
    const result = await lowConfidence.processDocument(fixture('receipt-photo.jpg'), '', 'r.jpg');
    expect(result.missingFields).toEqual([]);
    expect(result.reviewRequired).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Low OCR confidence/);
    expect(result.extraction?.confidence).toBe(41);
  });
});

describe('Attachments: application-level limits and stored MIME type', () => {
  const storageDir = path.resolve(process.cwd(), '.runtime', 'test-ocr-engine-storage');
  const ocrService = new DocumentOcrService();

  beforeAll(async () => {
    await fs.mkdir(storageDir, { recursive: true });
  });

  afterAll(async () => {
    await ocrService.terminate();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  function serviceWith(prisma: PrismaClient, maxAttachmentBytes?: number) {
    return new PracticeApplicationService(prisma, {
      storageService: new LocalStorageService(storageDir),
      ocrService,
      attachmentRepository: new AttachmentRepository(prisma),
      maxAttachmentBytes,
    });
  }

  it(
    'stores the MIME type detected from content and enriches the practice from a real photo',
    async () => {
      const { prisma, createAttachment } = mockPrismaForAttachments();
      const result = await serviceWith(prisma).addAttachment({
        tenantId,
        userId,
        practiceId,
        fileName: 'fattura.pdf',
        mimeType: 'application/pdf', // wrong on purpose: the content is a JPEG
        content: fixture('invoice-photo.jpg'),
      });

      const stored = createAttachment.mock.calls[0]?.[0] as { data: { mimeType: string } };
      expect(stored.data.mimeType).toBe('image/jpeg');
      expect(result.ocrResult?.documentType).toBe('invoice');
      expect((result.ocrResult as InvoiceOcr).totalAmount).toBe(1525.61);

      const payload = result.practice.payload as {
        attachments: Array<{ reviewRequired: boolean }>;
        lastOcrResult: InvoiceOcr;
      };
      expect(payload.attachments[0]?.reviewRequired).toBe(false);
      expect(payload.lastOcrResult.supplierVat).toBe('IT01234567897');
    },
    OCR_TIMEOUT,
  );

  it('rejects files above the size limit before storing them', async () => {
    const { prisma, createAttachment } = mockPrismaForAttachments();
    const attempt = serviceWith(prisma, 1024).addAttachment({
      tenantId,
      userId,
      practiceId,
      fileName: 'big.png',
      mimeType: 'image/png',
      content: fixture('invoice.png'),
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
      statusCode: 413,
    });
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it('rejects unsupported and empty files', async () => {
    const { prisma } = mockPrismaForAttachments();
    const service = serviceWith(prisma);
    const base = { tenantId, userId, practiceId, fileName: 'x', mimeType: 'application/pdf' };

    await expect(
      service.addAttachment({ ...base, content: Buffer.from([0x4d, 0x5a, 0x00, 0x01]) }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', statusCode: 415 });
    await expect(
      service.addAttachment({ ...base, content: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(AttachmentRejectedError);
  });
});

describe('Attachments: HTTP upload (multipart and base64)', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '3013',
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
    SERVICE_NAME: 'sinfonia-ocr-engine-test',
    ATTACHMENT_MAX_BYTES: '200000',
    ...TEST_AUTH_ENV,
  });

  function buildApp(practiceService: PracticeApplicationService) {
    return buildServer(config, createLogger(config), {
      practiceService,
      interpreterService: new InterpreterService({ complete: vi.fn() }),
      executorService: new ExecutorService({ practiceService }),
      contextService: {
        getPracticeContext: vi.fn().mockResolvedValue({ practices: [] }),
        getRelevantPracticeContext: vi.fn().mockResolvedValue({ practices: [] }),
      } as unknown as ContextService,
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
  }

  function multipartBody(file: Buffer, fileName: string, hint?: string, hintAfterFile = false) {
    const boundary = '----sinfoniaTestBoundary';
    const hintPart = hint
      ? [
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="hint"\r\n\r\n${hint}\r\n`,
          ),
        ]
      : [];
    const filePart = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      file,
      Buffer.from('\r\n'),
    ];
    const parts = hintAfterFile ? [...filePart, ...hintPart] : [...hintPart, ...filePart];
    return {
      payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  it('accepts a multipart photo upload and passes file, name and hint to the service', async () => {
    const addAttachment = vi.fn().mockResolvedValue({ attachment: { id: 'att-mp' } });
    const app = buildApp({ addAttachment } as unknown as PracticeApplicationService);
    const photo = fixture('receipt-photo.jpg');
    const body = multipartBody(photo, 'scontrino.jpg', 'scontrino pranzo');

    const res = await app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/attachments`,
      headers: { ...authHeaders(tenantId, userId, 'MEMBER'), 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(201);
    const call = addAttachment.mock.calls[0]?.[0] as {
      fileName: string;
      content: Buffer;
      hint?: string;
    };
    expect(call.fileName).toBe('scontrino.jpg');
    expect(call.hint).toBe('scontrino pranzo');
    expect(Buffer.compare(call.content, photo)).toBe(0);
  });

  it('accepts the multipart hint after the file too', async () => {
    const addAttachment = vi.fn().mockResolvedValue({ attachment: { id: 'att-mp2' } });
    const app = buildApp({ addAttachment } as unknown as PracticeApplicationService);
    const body = multipartBody(fixture('receipt-photo.jpg'), 'scontrino.jpg', 'pranzo', true);

    const res = await app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/attachments`,
      headers: { ...authHeaders(tenantId, userId, 'MEMBER'), 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(201);
    expect((addAttachment.mock.calls[0]?.[0] as { hint?: string }).hint).toBe('pranzo');
  });

  it('returns 413 for a multipart file above ATTACHMENT_MAX_BYTES', async () => {
    const addAttachment = vi.fn();
    const app = buildApp({ addAttachment } as unknown as PracticeApplicationService);
    const body = multipartBody(Buffer.alloc(250_000, 1), 'big.jpg');

    const res = await app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/attachments`,
      headers: { ...authHeaders(tenantId, userId, 'MEMBER'), 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(addAttachment).not.toHaveBeenCalled();
  });

  it('maps service rejections to 415 on base64 uploads', async () => {
    const addAttachment = vi
      .fn()
      .mockRejectedValue(new AttachmentRejectedError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported'));
    const app = buildApp({ addAttachment } as unknown as PracticeApplicationService);

    const res = await app.inject({
      method: 'POST',
      url: `/practices/${practiceId}/attachments`,
      headers: authHeaders(tenantId, userId, 'MEMBER'),
      payload: { fileName: 'x.exe', contentBase64: Buffer.from('MZ').toString('base64') },
    });

    expect(res.statusCode).toBe(415);
  });
});

describe('Telegram: attachment reply', () => {
  it('summarises extracted data and lists fields to verify', () => {
    const service = new DocumentOcrService({ ocrEngine: new FixedOcrEngine('', 0) });
    const result = service.parseDocumentText(
      'Fattura n. 12\nFornitore: Agricola Esempio S.r.l.\nTotale documento: 1.525,61',
      'f.txt',
    );
    const message = formatAttachmentResult('COMPLETED', result);
    expect(message).toContain('Tipo riconosciuto: Fattura');
    expect(message).toContain('Totale: 1525,61 €');
    expect(message).toContain('Da verificare');
    expect(message).toContain('partita IVA');
  });
});
