import { describe, expect, it, vi } from 'vitest';

import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import {
  CURRENT_INTERPRETER_SCHEMA_VERSION,
  InterpreterOutputSchema,
  InvalidAIOutputError,
} from '../src/ai/interpreter/interpreter.types.js';
import { parseAndRepairJSON } from '../src/ai/interpreter/json-repair.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { AITracer } from '../src/ai/tracing/ai.tracer.js';
import { loadConfig } from '../src/config/config.js';
import { buildServer } from '../src/interface/http/server.js';
import { formatTelegramResponse } from '../src/interface/telegram/telegram.formatter.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { ContextService, PracticeContext } from '../src/ai/context/context.service.js';
import type { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';

describe('Step 3B: Structured Output, Versioned Schema, Retry & Clarification Flow', () => {
  const baseConfig = loadConfig({
    NODE_ENV: 'test',
    PORT: '3011',
    DATABASE_URL: 'postgresql://dummy:dummy@localhost:5432/dummy',
    SERVICE_NAME: 'sinfonia-step3b-test',
    ...TEST_AUTH_ENV,
  });
  const logger = createLogger(baseConfig);

  // -------------------------------------------------------------------------
  // 1. Structured Output & Versioned Schema (schemaVersion: 1)
  // -------------------------------------------------------------------------
  describe('Structured Output & Versioned Schema', () => {
    it('validates schema with schemaVersion 1 and confidence field', () => {
      const valid = {
        schemaVersion: 1,
        action: 'transition_practice',
        confidence: 0.95,
        filters: { practiceId: '550e8400-e29b-41d4-a716-446655440000', status: null, name: null },
        artistName: null,
        nextState: 'VALIDATED',
        clarification: null,
      };

      const parsed = InterpreterOutputSchema.parse(valid);
      expect(parsed.schemaVersion).toBe(CURRENT_INTERPRETER_SCHEMA_VERSION);
      expect(parsed.confidence).toBe(0.95);
      expect(parsed.action).toBe('transition_practice');
    });

    it('applies defaults for schemaVersion (1) and confidence (1.0)', () => {
      const minimal = {
        action: 'create_practice',
        artistName: 'Mario Rossi',
        nextState: 'CREATED',
      };

      const parsed = InterpreterOutputSchema.parse(minimal);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.confidence).toBe(1.0);
      expect(parsed.clarification).toBeNull();
    });

    it('rejects invalid action or invalid confidence score', () => {
      const invalidAction = {
        schemaVersion: 1,
        action: 'unauthorized_action',
        confidence: 0.8,
        nextState: 'VALIDATED',
      };
      expect(() => InterpreterOutputSchema.parse(invalidAction)).toThrow();

      const invalidConfidence = {
        schemaVersion: 1,
        action: 'create_practice',
        confidence: 1.5, // > 1.0
        artistName: 'Test',
        nextState: 'CREATED',
      };
      expect(() => InterpreterOutputSchema.parse(invalidConfidence)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Retry con Riparazione Automatica (JSON Repair & LLM Retry)
  // -------------------------------------------------------------------------
  describe('Automatic JSON Repair & LLM Retry Mechanism', () => {
    it('repairs common LLM formatting issues: markdown fences, trailing commas, single quotes', () => {
      // Trailing comma + markdown code fence
      const rawWithTrailingComma =
        '```json\n{\n  "action": "create_practice",\n  "artistName": "Anna Rossi",\n  "nextState": "CREATED",\n}\n```';
      const repaired1 = parseAndRepairJSON(rawWithTrailingComma) as {
        action: string;
        artistName: string;
      };
      expect(repaired1).toBeDefined();
      expect(repaired1.action).toBe('create_practice');
      expect(repaired1.artistName).toBe('Anna Rossi');

      // Single-quoted keys and values
      const rawSingleQuotes = "{'action': 'transition_practice', 'nextState': 'VALIDATED'}";
      const repaired2 = parseAndRepairJSON(rawSingleQuotes) as {
        action: string;
        nextState: string;
      };
      expect(repaired2).toBeDefined();
      expect(repaired2.action).toBe('transition_practice');
      expect(repaired2.nextState).toBe('VALIDATED');

      // Text surrounding JSON
      const rawSurrounding =
        'Ecco il risultato richiesto: {"action": "create_practice", "artistName": "Trio FVG", "nextState": "CREATED"} Spero sia utile!';
      const repaired3 = parseAndRepairJSON(rawSurrounding) as { artistName: string };
      expect(repaired3).toBeDefined();
      expect(repaired3.artistName).toBe('Trio FVG');
    });

    it('retries with targeted repair prompt when LLM output is malformed and recovers', async () => {
      let callCount = 0;
      const brokenInitialOutput = 'Non-JSON text from confused model';
      const correctedOutput = JSON.stringify({
        schemaVersion: 1,
        action: 'create_practice',
        confidence: 0.98,
        artistName: 'Corretto su Retry',
        nextState: 'CREATED',
        clarification: null,
      });

      const mockLLM = {
        complete: vi.fn(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(brokenInitialOutput);
          return Promise.resolve(correctedOutput);
        }),
      };

      const interpreter = new InterpreterService({
        llm: mockLLM,
        maxRepairRetries: 2,
      });

      const res = await interpreter.interpret('crea pratica Corretto su Retry');
      expect(callCount).toBe(2); // Initial attempt + 1 repair retry
      expect(res.action).toBe('create_practice');
      expect(res.artistName).toBe('Corretto su Retry');
      expect(res.schemaVersion).toBe(1);
    });

    it('throws InvalidAIOutputError after exhausting max repair retries', async () => {
      let callCount = 0;
      const mockLLM = {
        complete: vi.fn(() => {
          callCount++;
          return Promise.resolve('Ancora testo non valido');
        }),
      };

      const interpreter = new InterpreterService({
        llm: mockLLM,
        maxRepairRetries: 2,
      });

      await expect(interpreter.interpret('test input')).rejects.toThrow(InvalidAIOutputError);
      expect(callCount).toBe(3); // 1 initial + 2 repair retries
    });
  });

  // -------------------------------------------------------------------------
  // 3. Soglia di Confidenza & Zero Ambiguità (CLARIFICATION_REQUIRED)
  // -------------------------------------------------------------------------
  describe('Confidence Threshold & Zero Ambiguity Enforcement', () => {
    it('converts low-confidence outputs (<0.75) into CLARIFICATION_REQUIRED with targeted questions', async () => {
      const lowConfidenceOutput = JSON.stringify({
        schemaVersion: 1,
        action: 'transition_practice',
        confidence: 0.55, // < threshold 0.75
        filters: { practiceId: null, status: 'CREATED', name: null },
        artistName: null,
        nextState: 'VALIDATED',
        clarification: null,
      });

      const interpreter = new InterpreterService({
        llm: { complete: vi.fn().mockResolvedValue(lowConfidenceOutput) },
        confidenceThreshold: 0.75,
      });

      const res = await interpreter.interpret('forse vorrei validare una pratica');
      expect(res.action).toBe('clarification_required');
      expect(res.confidence).toBe(0.55);
      expect(res.nextState).toBeNull();
      expect(res.clarification).toBeDefined();
      expect(res.clarification?.reason).toBe('LOW_CONFIDENCE');
      expect(res.clarification?.question).toContain('55%');
    });

    it('DecisionEngine generates CLARIFICATION_REQUIRED when multiple candidate practices match', () => {
      const decisionEngine = new DecisionEngine();
      const context: PracticeContext = {
        practices: [
          {
            id: '550e8400-e29b-41d4-a716-446655440001',
            name: 'Mario Rossi Live',
            status: 'CREATED',
            type: 'music practice',
            summary: 'Concerto live',
          },
          {
            id: '550e8400-e29b-41d4-a716-446655440002',
            name: 'Mario Rossi Studio',
            status: 'CREATED',
            type: 'music practice',
            summary: 'Registrazione studio',
          },
        ],
      };

      const input = {
        schemaVersion: 1,
        action: 'transition_practice' as const,
        confidence: 0.9,
        filters: { practiceId: null, status: 'CREATED', name: 'Mario Rossi' },
        artistName: null,
        nextState: 'VALIDATED',
        clarification: null,
      };

      const resolved = decisionEngine.resolveCommand(input, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        practices: context.practices,
      });

      expect(resolved.action).toBe('clarification_required');
      expect(resolved.data.reason).toBe('MULTIPLE_CANDIDATES');
      expect(resolved.data.candidatePracticeIds as string[]).toHaveLength(2);
      expect(resolved.data.options as string[]).toContain('Mario Rossi Live');
      expect(resolved.data.options as string[]).toContain('Mario Rossi Studio');
      expect(resolved.data.question as string).toContain('Ho individuato 2 pratiche');
    });

    it('DecisionEngine generates CLARIFICATION_REQUIRED when zero practices match', () => {
      const decisionEngine = new DecisionEngine();
      const context: PracticeContext = {
        practices: [
          {
            id: '550e8400-e29b-41d4-a716-446655440001',
            name: 'Luigi Verdi',
            status: 'CREATED',
            type: 'music practice',
            summary: 'Pratica esistente',
          },
        ],
      };

      const input = {
        schemaVersion: 1,
        action: 'transition_practice' as const,
        confidence: 0.95,
        filters: { practiceId: null, status: 'CREATED', name: 'Inesistente Mario' },
        artistName: null,
        nextState: 'VALIDATED',
        clarification: null,
      };

      const resolved = decisionEngine.resolveCommand(input, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        practices: context.practices,
      });

      expect(resolved.action).toBe('clarification_required');
      expect(resolved.data.reason).toBe('ZERO_CANDIDATES');
      expect(resolved.data.question as string).toContain('Non ho trovato alcuna pratica');
      expect(resolved.data.options as string[]).toContain('Crea nuova pratica');
    });

    it('guarantees zero state mutation in executor when CLARIFICATION_REQUIRED is resolved', async () => {
      const createMock = vi.fn();
      const transitionMock = vi.fn();

      const mockPracticeService = {
        createPractice: createMock,
        transitionPractice: transitionMock,
      } as unknown as PracticeApplicationService;

      const executor = new ExecutorService({ practiceService: mockPracticeService });

      const clarificationCmd = {
        action: 'clarification_required',
        data: {
          question: 'Quale delle due pratiche vuoi validare?',
          reason: 'MULTIPLE_CANDIDATES',
          options: ['Pratica A', 'Pratica B'],
          confidence: 0.5,
        },
      };

      const result = await executor.execute(clarificationCmd, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.result as { type: string }).type).toBe('clarification_required');
      }

      // STRICT ZERO MUTATION: neither createPractice nor transitionPractice was touched!
      expect(createMock).not.toHaveBeenCalled();
      expect(transitionMock).not.toHaveBeenCalled();
    });

    it('end-to-end HTTP: POST /ai/execute returns structured clarification and logs AMBIGUOUS trace', async () => {
      const tenantId = '55555555-5555-4555-8555-555555555555';
      const userId = '66666666-6666-4666-8666-666666666666';

      // 2 candidate practices in context
      const contextPractices = [
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          name: 'Spesa Vini FVG A',
          status: 'CREATED' as const,
          type: 'generic practice',
          summary: 'Fattura A',
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440002',
          name: 'Spesa Vini FVG B',
          status: 'CREATED' as const,
          type: 'generic practice',
          summary: 'Fattura B',
        },
      ];

      const mockPracticeService = {
        listPractices: vi.fn().mockResolvedValue(contextPractices),
      } as unknown as PracticeApplicationService;

      const mockLLM = {
        complete: vi.fn().mockResolvedValue(
          JSON.stringify({
            schemaVersion: 1,
            action: 'transition_practice',
            confidence: 0.95,
            filters: { practiceId: null, status: 'CREATED', name: 'Spesa Vini FVG' },
            artistName: null,
            nextState: 'VALIDATED',
            clarification: null,
          }),
        ),
      };

      const interpreterService = new InterpreterService(mockLLM);
      const executorService = new ExecutorService({ practiceService: mockPracticeService });
      const contextService = {
        getPracticeContext: vi.fn().mockResolvedValue({ practices: contextPractices }),
        getRelevantPracticeContext: vi.fn().mockResolvedValue({ practices: contextPractices }),
      } as unknown as ContextService;
      const decisionEngine = new DecisionEngine();
      const normalizerService = new NormalizerService();
      const tracer = new AITracer();

      const app = buildServer(baseConfig, logger, {
        principals: testPrincipals(),
        practiceService: mockPracticeService,
        interpreterService,
        executorService,
        contextService,
        decisionEngine,
        normalizerService,
        tracer,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/ai/execute',
        headers: authHeaders(tenantId, userId, 'ADMIN'),
        payload: { input: 'valida la pratica Spesa Vini FVG' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        success: boolean;
        result: {
          type: string;
          question: string;
          options: string[];
          reason: string;
        };
        meta: { trace: { outcome: string; action: string } };
      }>();

      expect(body.success).toBe(true);
      expect(body.result.type).toBe('clarification_required');
      expect(body.result.reason).toBe('MULTIPLE_CANDIDATES');
      expect(body.result.options).toHaveLength(2);
      expect(body.meta.trace.outcome).toBe('AMBIGUOUS');
      expect(body.meta.trace.action).toBe('clarification_required');

      await app.close();
    });

    it('Telegram formatter produces interactive question with option bullets for clarification', () => {
      const formatted = formatTelegramResponse({
        input: 'valida la pratica',
        command: {
          action: 'clarification_required',
          data: {},
        },
        result: {
          success: true,
          result: {
            type: 'clarification_required',
            question: 'Ho trovato 2 pratiche attive. Quale vuoi validare?',
            options: ['Fattura A (€ 120)', 'Fattura B (€ 450)'],
          },
        },
      });

      expect(formatted).toContain('Ho trovato 2 pratiche attive');
      expect(formatted).toContain('• Fattura A (€ 120)');
      expect(formatted).toContain('• Fattura B (€ 450)');
    });
  });
});
