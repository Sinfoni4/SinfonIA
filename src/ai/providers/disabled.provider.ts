import type { LLMClient } from '../interpreter/interpreter.service.js';

export class LLMDisabledError extends Error {
  public readonly code = 'LLM_DISABLED';

  constructor(
    message = 'Il motore AI/LLM è disabilitato. Sono supportati solo i comandi deterministici: "crea pratica <nome>", "stato pratica <nome>", "export pratiche [oggi|mese|anno]".',
  ) {
    super(message);
    this.name = 'LLMDisabledError';
  }
}

export function createDisabledLLMClient(
  reason = 'LLM is disabled via ENABLE_LLM=false or missing OPENAI_API_KEY',
): LLMClient {
  return {
    mode: 'disabled',
    model: 'none',
    providerName: 'disabled',
    statusMessage: reason,
    complete: () => Promise.reject(new LLMDisabledError()),
    completeDetailed: () => Promise.reject(new LLMDisabledError()),
  };
}
