import { LLMDisabledError } from '../providers/disabled.provider.js';

import { buildInterpreterPrompt } from './interpreter.prompt.js';
import {
  type InterpreterContext,
  InterpreterError,
  InterpreterOutputSchema,
  InvalidAIOutputError,
} from './interpreter.types.js';

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
};

export class InterpreterService {
  private readonly deps: InterpreterServiceDeps;

  constructor(deps: InterpreterServiceDeps | LLMClient) {
    this.deps = 'complete' in deps ? { llm: deps } : deps;
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

    const prompt = buildInterpreterPrompt(inputText, context);

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
      this.deps.log.debug({ responseLength: raw.length }, 'LLM response received');
    }

    const parsed = parseJSONWithFallback(raw);
    if (parsed === null) {
      throw new InvalidAIOutputError('AI output is not valid JSON');
    }

    if (isAmbiguousMarker(parsed)) {
      throw new InterpreterError('Ambiguous input: cannot derive deterministic action');
    }

    const validated = InterpreterOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new InvalidAIOutputError('AI output does not match interpreter contract');
    }

    return {
      output: validated.data,
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

/**
 * Parse JSON with fallback: strip markdown code fences if present.
 */
function parseJSONWithFallback(raw: string): unknown {
  let text = raw.trim();
  const codeBlockMatch = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(text);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isAmbiguousMarker(value: unknown): value is { error: 'AMBIGUOUS_INPUT' } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  return (value as { error?: unknown }).error === 'AMBIGUOUS_INPUT';
}
