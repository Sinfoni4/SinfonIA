import { LLMDisabledError } from '../providers/disabled.provider.js';
import { maskPII, unmaskObjectPII } from '../security/pii-minimizer.js';
import { checkPromptInjection } from '../security/prompt-guard.js';

import { buildInterpreterPrompt, buildRepairPrompt } from './interpreter.prompt.js';
import {
  CURRENT_INTERPRETER_SCHEMA_VERSION,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type InterpreterContext,
  InterpreterError,
  InterpreterOutputSchema,
  InvalidAIOutputError,
} from './interpreter.types.js';
import { parseAndRepairJSON } from './json-repair.js';

import type { InterpreterOutput } from './interpreter.types.js';

export type LLMCompletionResult = {
  text: string;
  model?: string;
  provider?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

export type LLMClient = {
  complete(prompt: string): Promise<string>;
  completeDetailed?(prompt: string): Promise<LLMCompletionResult>;
  mode?: 'real' | 'stub' | 'disabled';
  model?: string;
  providerName?: string;
  statusMessage?: string;
};

export type InterpreterDetailsResult = {
  output: InterpreterOutput;
  traceMeta: {
    model: string;
    provider: string;
    tokens?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
};

export type InterpreterServiceDeps = {
  llm: LLMClient;
  /** Optional logger for debug (e.g. log raw LLM output when level is debug). */
  log?: { debug: (obj: unknown, msg?: string) => void };
  confidenceThreshold?: number;
  maxRepairRetries?: number;
};

export class InterpreterService {
  private readonly deps: InterpreterServiceDeps;
  public readonly confidenceThreshold: number;
  public readonly maxRepairRetries: number;

  constructor(deps: InterpreterServiceDeps | LLMClient) {
    this.deps = 'complete' in deps ? { llm: deps } : deps;
    this.confidenceThreshold = this.deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.maxRepairRetries = this.deps.maxRepairRetries ?? 2;
  }

  isLLMEnabled(): boolean {
    return this.deps.llm.mode !== 'disabled';
  }

  isRealLLM(): boolean {
    return this.deps.llm.mode === 'real';
  }

  getModelName(): string {
    return this.deps.llm.model ?? (this.isRealLLM() ? 'openai' : (this.deps.llm.mode ?? 'unknown'));
  }

  getProviderName(): string {
    return (
      this.deps.llm.providerName ??
      (this.isRealLLM() ? 'openai' : (this.deps.llm.mode ?? 'unknown'))
    );
  }

  async interpretWithDetails(
    inputText: string,
    context?: InterpreterContext,
  ): Promise<InterpreterDetailsResult> {
    if (!this.isLLMEnabled()) {
      throw new LLMDisabledError(this.deps.llm.statusMessage);
    }

    if (inputText.trim().length === 0) {
      throw new InterpreterError('Input text is empty');
    }

    const injectionCheck = checkPromptInjection(inputText);
    if (injectionCheck.isInjection) {
      if (this.deps.log) {
        this.deps.log.debug(
          { attackType: injectionCheck.attackType, reason: injectionCheck.reason },
          'Prompt injection blocked pre-execution',
        );
      }
      return {
        output: {
          schemaVersion: CURRENT_INTERPRETER_SCHEMA_VERSION,
          action: 'clarification_required',
          confidence: 0.1,
          filters: { practiceId: null, status: null, name: null },
          artistName: null,
          nextState: null,
          clarification: {
            question:
              "La richiesta contiene istruzioni di sistema o comandi non consentiti. Puoi indicare un'operazione valida su una pratica (es. 'crea pratica Mario Rossi' o 'valida pratica Mario Rossi')?",
            reason: `SECURITY_INJECTION_BLOCKED:${injectionCheck.attackType ?? 'UNKNOWN'}`,
            candidatePracticeIds: [],
            options: ['Crea nuova pratica', 'Valida pratica', 'Controlla stato pratiche'],
          },
        },
        traceMeta: {
          model: this.getModelName(),
          provider: this.getProviderName(),
        },
      };
    }

    const { maskedText, piiMap } = maskPII(inputText);
    const prompt = buildInterpreterPrompt(maskedText, context);

    let raw: string;
    let model = this.getModelName();
    let provider = this.getProviderName();
    let tokens: LLMCompletionResult['usage'] | undefined;

    if (typeof this.deps.llm.completeDetailed === 'function') {
      const detailed = await this.deps.llm.completeDetailed(prompt);
      raw = detailed.text;
      if (detailed.model) model = detailed.model;
      if (detailed.provider) provider = detailed.provider;
      tokens = detailed.usage;
    } else {
      raw = await this.deps.llm.complete(prompt);
    }

    if (this.deps.log) {
      this.deps.log.debug({ responseLength: raw.length }, 'LLM initial response received');
    }

    let parsed = parseAndRepairJSON(raw);
    let validation = parsed ? InterpreterOutputSchema.safeParse(parsed) : null;

    // Retry loop with automatic JSON repair and targeted error feedback
    let repairAttempts = 0;
    while ((!parsed || !validation?.success) && repairAttempts < this.maxRepairRetries) {
      repairAttempts++;
      const errorMessage = !parsed
        ? 'Invalid JSON syntax'
        : (validation?.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ') ??
          'Schema validation failure');

      if (this.deps.log) {
        this.deps.log.debug(
          { attempt: repairAttempts, error: errorMessage },
          'Attempting LLM automatic repair',
        );
      }

      const repairPrompt = buildRepairPrompt(maskedText, raw, errorMessage);
      raw = await this.deps.llm.complete(repairPrompt);
      parsed = parseAndRepairJSON(raw);
      if (parsed) {
        validation = InterpreterOutputSchema.safeParse(parsed);
      }
    }

    // If still not parseable after repairs, check for explicit ambiguous marker
    if (parsed && isAmbiguousMarker(parsed)) {
      throw new InterpreterError('Ambiguous input: cannot derive deterministic action');
    }

    if (!parsed) {
      throw new InvalidAIOutputError('AI output is not valid JSON even after repair attempts');
    }

    if (!validation?.success) {
      throw new InvalidAIOutputError(
        `AI output does not match interpreter contract (v${CURRENT_INTERPRETER_SCHEMA_VERSION})`,
      );
    }

    let output = validation.data;
    if (piiMap.size > 0) {
      output = unmaskObjectPII(output, piiMap);
    }

    // Confidence threshold evaluation: if confidence is below threshold, generate CLARIFICATION_REQUIRED
    if (
      output.action !== 'clarification_required' &&
      output.confidence < this.confidenceThreshold
    ) {
      output = {
        schemaVersion: CURRENT_INTERPRETER_SCHEMA_VERSION,
        action: 'clarification_required',
        confidence: output.confidence,
        filters: output.filters,
        artistName: output.artistName,
        nextState: null,
        clarification: {
          question: `La tua richiesta non è del tutto chiara (confidenza: ${Math.round(output.confidence * 100)}%). Desideri ${output.action === 'create_practice' ? 'creare una pratica' : 'modificare lo stato di una pratica'}?`,
          reason: 'LOW_CONFIDENCE',
          candidatePracticeIds: output.filters.practiceId ? [output.filters.practiceId] : [],
          options: ['Conferma operazione', 'Annulla operazione', 'Mostra elenco pratiche'],
        },
      };
    }

    return {
      output,
      traceMeta: {
        model,
        provider,
        tokens,
      },
    };
  }

  async interpret(inputText: string, context?: InterpreterContext): Promise<InterpreterOutput> {
    const res = await this.interpretWithDetails(inputText, context);
    return res.output;
  }
}

function isAmbiguousMarker(value: unknown): value is { error: 'AMBIGUOUS_INPUT' } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  return (value as { error?: unknown }).error === 'AMBIGUOUS_INPUT';
}
