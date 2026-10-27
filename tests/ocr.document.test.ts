import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { DocumentOcrService } from '../src/ai/ocr/document-ocr.service.js';
import {
  DeliveryNoteOcrSchema,
  InvoiceOcrSchema,
  ReceiptOcrSchema,
} from '../src/ai/ocr/ocr.types.js';
import { AITracer } from '../src/ai/tracing/ai.tracer.js';
import { loadConfig } from '../src/config/config.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { AttachmentRepository } from '../src/data/repositories/attachment.repository.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV } from './helpers/auth.js';

import type { ContextService } from '../src/ai/context/context.service.js';
import type { PrismaClient } from '@prisma/client';

describe('Phase 3B: Document AI, OCR & Multimodal Attachments', () => {
  const testStorageDir = path.resolve(process.cwd(), '.runtime', 'test-ocr-storage');
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const otherTenantId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const practiceId = '44444444-4444-4444-8444-444444444444';

  const baseConfig = loadConfig({
    NODE_ENV: 'test',
    PORT: '3012',
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
    SERVICE_NAME: 'sinfonia-ocr-test',
    ...TEST_AUTH_ENV,
  });
  const logger = createLogger(baseConfig);

  beforeAll(async () => {
    await fs.mkdir(testStorageDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testStorageDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Isolated Document Storage (LocalStorageService)
  // -------------------------------------------------------------------------
  describe('LocalStorageService (Tenant Isolation & Path Traversal Prevention)', () => {
    const storageService = new LocalStorageService(testStorageDir);

    it('saves a document inside the tenant-isolated directory', async () => {
      const buffer = Buffer.from('Contenuto fattura di prova');
      const saved = await storageService.save(tenantId, 'fattura.pdf', buffer);

      expect(saved.storagePath).toContain(tenantId);
      expect(saved.fileSize).toBe(buffer.length);

      const readBack = await storageService.read(tenantId, saved.storagePath);
      expect(readBack.toString('utf-8')).toBe('Contenuto fattura di prova');
    });

    it('deletes a document cleanly', async () => {
      const buffer = Buffer.from('Documento da eliminare');
      const saved = await storageService.save(tenantId, 'temp.pdf', buffer);

      await storageService.delete(tenantId, saved.storagePath);
      await expect(storageService.read(tenantId, saved.storagePath)).rejects.toThrow();
    });

    it('strictly forbids path traversal outside the tenant directory', async () => {
      await expect(storageService.read(tenantId, `../${otherTenantId}/secret.pdf`)).rejects.toThrow(
        /Access denied/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Document AI & OCR Engine (DocumentOcrService)
  // -------------------------------------------------------------------------
  describe('DocumentOcrService Parsing Pipeline', () => {
    const ocrService = new DocumentOcrService();

    it('extracts structured data from an Italian invoice (Fattura Fornitore)', async () => {
      const invoiceText = `
        AZIENDA AGRICOLA COLLI SRL
        Partita IVA: IT01234567890
        Fattura n. FT-2026/104
        Data: 15/10/2026
        Destinatario: TerreFVG Consorzio
        Imponibile: € 1.250,50
        IVA 22%: € 275,11
        Totale documento: € 1.525,61
      `;
      const result = await ocrService.processDocument(
        Buffer.from(invoiceText),
        'text/plain',
        'fattura_colli.txt',
      );

      expect(result.documentType).toBe('invoice');
      const invoice = InvoiceOcrSchema.parse(result);
      expect(invoice.supplierName).toContain('AZIENDA AGRICOLA COLLI');
      expect(invoice.supplierVat).toBe('IT01234567890');
      expect(invoice.documentNumber).toBe('FT-2026/104');
      expect(invoice.documentDate).toBe('2026-10-15');
      expect(invoice.taxableAmount).toBe(1250.5);
      expect(invoice.vatAmount).toBe(275.11);
      expect(invoice.totalAmount).toBe(1525.61);
      expect(invoice.currency).toBe('EUR');
    });

    it('extracts structured items from a Delivery Note (DDT)', async () => {
      const ddtText = `
        DOCUMENTO DI TRASPORTO (DDT)
        Mittente: Cantina Cooperativa Friuli P.IVA 98765432101
        Destinatario: Ristorante Terre Antiche
        DDT N. 2026-088 del 20/10/2026
        - Bottiglie Friulano DOC quantita: 120
        - Cartoni Refosco dal Peduncolo Rosso x 50
      `;
      const result = await ocrService.processDocument(
        Buffer.from(ddtText),
        'text/plain',
        'ddt_consegna.txt',
      );

      expect(result.documentType).toBe('delivery_note');
      const ddt = DeliveryNoteOcrSchema.parse(result);
      expect(ddt.documentNumber).toBe('2026-088');
      expect(ddt.supplierVat).toBe('98765432101');
      expect(ddt.recipientName).toContain('Ristorante Terre Antiche');
      expect(ddt.items.length).toBeGreaterThanOrEqual(2);
      expect(ddt.items[0]?.quantity).toBe(120);
    });

    it('extracts structured data from a receipt (Scontrino Fiscale)', async () => {
      const receiptText = `
        TRATTORIA FRIULI VENEZIA GIULIA
        Scontrino Fiscale
        Data: 25/10/2026
        Totale: € 45,80
      `;
      const result = await ocrService.processDocument(
        Buffer.from(receiptText),
        'text/plain',
        'scontrino.txt',
      );

      expect(result.documentType).toBe('receipt');
      const receipt = ReceiptOcrSchema.parse(result);
      expect(receipt.merchantName).toContain('TRATTORIA FRIULI');
      expect(receipt.documentDate).toBe('2026-10-25');
      expect(receipt.totalAmount).toBe(45.8);
    });

    it('falls back to generic document analysis when text does not match invoice/ddt/receipt', async () => {
      const genericText = `
        RETE DI IMPRESE TERREFVG
        Statuto del consorzio agroalimentare regionale.
        Collaborazione tra aziende agricole e artigiani del territorio.
      `;
      const result = await ocrService.processDocument(
        Buffer.from(genericText),
        'text/plain',
        'statuto.txt',
      );

      expect(result.documentType).toBe('generic');
      if (result.documentType === 'generic') {
        expect(result.detectedKeywords).toContain('consorzio');
        expect(result.detectedKeywords).toContain('aziende');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Practice Enrichment & Attachment Lifecycle
  // -------------------------------------------------------------------------
  describe('Practice Application Service (Attachment & Enrichment)', () => {
    it('saves attachment, executes OCR, and enriches practice payload JSONB', async () => {
      const storageService = new LocalStorageService(testStorageDir);
      const ocrService = new DocumentOcrService();

      let currentPracticePayload: Record<string, unknown> = {
        name: 'Pratica TerreFVG Vendemmia',
        kind: 'generic',
        schemaVersion: 1,
      };

      const mockPrisma = {
        practice: {
          findFirst: vi.fn().mockImplementation(() =>
            Promise.resolve({
              id: practiceId,
              tenantId,
              userId,
              status: 'CREATED',
              version: 1,
              payload: currentPracticePayload,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          ),
          updateMany: vi.fn().mockImplementation((args: { data: { payload: unknown } }) => {
            currentPracticePayload = args.data.payload as Record<string, unknown>;
            return Promise.resolve({ count: 1 });
          }),
        },
        practiceAttachment: {
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: 'att-1234',
              tenantId,
              practiceId,
              fileName: args.data.fileName,
              mimeType: args.data.mimeType,
              fileSize: args.data.fileSize,
              storagePath: args.data.storagePath,
              ocrStatus: args.data.ocrStatus,
              ocrResult: args.data.ocrResult,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          ),
          findMany: vi.fn().mockImplementation(() =>
            Promise.resolve([
              {
                id: 'att-1234',
                tenantId,
                practiceId,
                fileName: 'fattura_uva.pdf',
                mimeType: 'application/pdf',
                fileSize: 1024,
                storagePath: `${tenantId}/fattura_uva.pdf`,
                ocrStatus: 'COMPLETED',
                ocrResult: { documentType: 'invoice' },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          ),
        },
      } as unknown as PrismaClient;

      const attachmentRepo = new AttachmentRepository(mockPrisma);
      const practiceService = new PracticeApplicationService(mockPrisma, {
        storageService,
        ocrService,
        attachmentRepository: attachmentRepo,
      });

      const invoiceContent = `
        Fattura n. 2026/01
        Fornitore: Agricola Friuli SRL
        Partita IVA: 00112233445
        Data: 2026-10-18
        Imponibile: € 800,00
        IVA: € 176,00
        Totale: € 976,00
      `;

      const result = await practiceService.addAttachment({
        tenantId,
        userId,
        practiceId,
        fileName: 'fattura_uva.pdf',
        mimeType: 'text/plain',
        content: Buffer.from(invoiceContent),
        hint: 'fattura fornitore',
      });

      expect(result.attachment.ocrStatus).toBe('COMPLETED');
      expect(result.attachment.fileName).toBe('fattura_uva.pdf');
      expect(result.ocrResult?.documentType).toBe('invoice');

      // Check practice payload enrichment
      const enrichedPayload = result.practice.payload as {
        attachments: Array<{ id: string; fileName: string; ocrStatus: string }>;
        lastOcrResult: { documentType: string };
      };
      expect(enrichedPayload.attachments).toHaveLength(1);
      expect(enrichedPayload.attachments[0]?.fileName).toBe('fattura_uva.pdf');
      expect(enrichedPayload.lastOcrResult.documentType).toBe('invoice');

      // Test listing attachments
      const list = await practiceService.listAttachments({
        tenantId,
        practiceId,
        userId,
      });
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe('att-1234');
    });

    it('rejects access when user tries to attach file to a practice of another user', async () => {
      const mockPrisma = {
        practice: {
          findFirst: vi.fn().mockResolvedValue({
            id: practiceId,
            tenantId,
            userId: 'another-user-999',
            status: 'CREATED',
            version: 1,
            payload: { name: 'Altra Pratica' },
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      } as unknown as PrismaClient;

      const practiceService = new PracticeApplicationService(mockPrisma);

      await expect(
        practiceService.addAttachment({
          tenantId,
          userId,
          practiceId,
          fileName: 'doc.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('data'),
        }),
      ).rejects.toThrow(/Practice not found/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Fastify HTTP Endpoints (POST /practices/:id/attachments & GET)
  // -------------------------------------------------------------------------
  describe('HTTP REST Routes (POST & GET /practices/:id/attachments)', () => {
    it('POST /practices/:id/attachments uploads base64 file, performs OCR, and returns 201', async () => {
      const mockAttachment = {
        id: 'att-http-1',
        tenantId,
        practiceId,
        fileName: 'ricevuta.txt',
        mimeType: 'text/plain',
        fileSize: 120,
        storagePath: 'storage/ricevuta.txt',
        ocrStatus: 'COMPLETED' as const,
        ocrResult: { documentType: 'receipt', totalAmount: 35.5 },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockEnrichedPractice = {
        id: practiceId,
        tenantId,
        userId,
        status: 'CREATED' as const,
        version: 1,
        schemaVersion: 1,
        name: 'Pratica Test',
        kind: 'generic' as const,
        typeLabel: 'generic practice',
        summary: 'generic practice Pratica Test',
        payload: { lastOcrResult: mockAttachment.ocrResult },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPracticeService = {
        addAttachment: vi.fn().mockResolvedValue({
          attachment: mockAttachment,
          practice: mockEnrichedPractice,
          ocrResult: mockAttachment.ocrResult,
        }),
        listAttachments: vi.fn().mockResolvedValue([mockAttachment]),
      } as unknown as PracticeApplicationService;

      const mockLLM = {
        complete: vi.fn().mockResolvedValue('{}'),
      };
      const interpreterService = new InterpreterService(mockLLM);
      const executorService = new ExecutorService({ practiceService: mockPracticeService });
      const contextService = {
        getPracticeContext: vi.fn().mockResolvedValue({ practices: [] }),
        getRelevantPracticeContext: vi.fn().mockResolvedValue({ practices: [] }),
      } as unknown as ContextService;
      const decisionEngine = new DecisionEngine();
      const normalizerService = new NormalizerService();
      const tracer = new AITracer();

      const app = buildServer(baseConfig, logger, {
        practiceService: mockPracticeService,
        interpreterService,
        executorService,
        contextService,
        decisionEngine,
        normalizerService,
        tracer,
      });

      const fileContent = 'TRATTORIA MOCK Scontrino Totale: € 35,50 Data: 2026-10-25';
      const base64Content = Buffer.from(fileContent).toString('base64');

      // 1. POST /practices/:id/attachments
      const postRes = await app.inject({
        method: 'POST',
        url: `/practices/${practiceId}/attachments`,
        headers: authHeaders(tenantId, userId, 'MEMBER'),
        payload: {
          fileName: 'ricevuta.txt',
          mimeType: 'text/plain',
          contentBase64: base64Content,
          hint: 'scontrino pranzo',
        },
      });

      expect(postRes.statusCode).toBe(201);
      const postBody = postRes.json<{
        success: boolean;
        data: {
          attachment: { id: string; fileName: string; ocrStatus: string };
          practice: { id: string; payload: { lastOcrResult: { totalAmount: number } } };
          ocrResult: { documentType: string };
        };
      }>();

      expect(postBody.success).toBe(true);
      expect(postBody.data.attachment.id).toBe('att-http-1');
      expect(postBody.data.ocrResult.documentType).toBe('receipt');
      expect(postBody.data.practice.payload.lastOcrResult.totalAmount).toBe(35.5);

      // 2. GET /practices/:id/attachments
      const getRes = await app.inject({
        method: 'GET',
        url: `/practices/${practiceId}/attachments`,
        headers: authHeaders(tenantId, userId, 'MEMBER'),
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json<{
        success: boolean;
        data: Array<{ id: string; fileName: string }>;
      }>();
      expect(getBody.success).toBe(true);
      expect(getBody.data).toHaveLength(1);
      expect(getBody.data[0]?.id).toBe('att-http-1');
    });

    it('returns 400 when contentBase64 is omitted from upload body', async () => {
      const mockPracticeService = {} as unknown as PracticeApplicationService;
      const interpreterService = new InterpreterService({ complete: vi.fn() });
      const executorService = new ExecutorService({ practiceService: mockPracticeService });
      const contextService = {
        getPracticeContext: vi.fn().mockResolvedValue({ practices: [] }),
        getRelevantPracticeContext: vi.fn().mockResolvedValue({ practices: [] }),
      } as unknown as ContextService;
      const decisionEngine = new DecisionEngine();
      const normalizerService = new NormalizerService();

      const app = buildServer(baseConfig, logger, {
        practiceService: mockPracticeService,
        interpreterService,
        executorService,
        contextService,
        decisionEngine,
        normalizerService,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/practices/${practiceId}/attachments`,
        headers: authHeaders(tenantId, userId, 'MEMBER'),
        payload: {
          fileName: 'missing_content.pdf',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
