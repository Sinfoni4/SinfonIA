import { buildInterpreterPrompt } from './interpreter.prompt.js';
import {
  type InterpreterContext,
  InterpreterError,
  InterpreterOutputSchema,
  InvalidAIOutputError,
} from './interpreter.types.js';

import type { InterpreterOutput } from './interpreter.types.js';

export type LLMClient = {
  complete(prompt: string): Promise<string>;
  mode?: 'real' | 'stub';
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

  async interpret(inputText: string, context?: InterpreterContext): Promise<InterpreterOutput> {
    if (inputText.trim().length === 0) {
      throw new InterpreterError('Input text is empty');
    }

    const prompt = buildInterpreterPrompt(inputText, context);
    const raw = await this.deps.llm.complete(prompt);

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

    return validated.data;
  }

  isRealLLM(): boolean {
    return this.deps.llm.mode === 'real';
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
