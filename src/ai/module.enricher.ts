import { errorLabel } from '../shared/errors.js';

import { formatDomainContext } from './context.formatter.js';

import type { DomainContext } from '../modules/domain.module.js';

export interface EnricherInput {
  userInput: string;
  moduleName: string;
  baseMessage: string;
  domainContext?: DomainContext;
}

/**
 * Post-processes module output with optional AI insight (safe placeholder — no external LLM yet).
 */
export function enrichWithAI(input: EnricherInput): Promise<string> {
  try {
    // ⚠️ SAFE MODE — nessuna dipendenza esterna obbligatoria
    // Placeholder per futura integrazione LLM

    const contextString = formatDomainContext(input.moduleName, input.domainContext);

    return Promise.resolve(`${input.baseMessage}

🧠 (AI insight)
${contextString}`);
  } catch (err) {
    console.error('❌ AI ENRICHMENT FAILED', errorLabel(err));
    return Promise.resolve(input.baseMessage);
  }
}
