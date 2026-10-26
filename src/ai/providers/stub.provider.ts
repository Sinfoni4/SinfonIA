import type { LLMClient } from '../interpreter/interpreter.service.js';

/**
 * Deterministic local fallback LLM:
 * - extracts UUID + target status from prompt text
 * - returns AMBIGUOUS_INPUT when insufficient evidence
 */
export function createDeterministicStubLLM(): LLMClient {
  function complete(prompt: string): Promise<string> {
    const input = extractUserInput(prompt).toLowerCase();
    const uuidMatch = input.match(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    );
    if (!uuidMatch) return Promise.resolve(JSON.stringify({ error: 'AMBIGUOUS_INPUT' }));

    const nextState = pickState(input);
    if (!nextState) return Promise.resolve(JSON.stringify({ error: 'AMBIGUOUS_INPUT' }));

    return Promise.resolve(
      JSON.stringify({
        action: 'transition_practice',
        filters: { practiceId: uuidMatch[0], status: null, name: null },
        artistName: null,
        nextState,
      }),
    );
  }

  return {
    mode: 'stub',
    model: 'deterministic-stub',
    providerName: 'stub',
    complete,
    completeDetailed: async (prompt: string) => {
      const text = await complete(prompt);
      return {
        text,
        model: 'deterministic-stub',
        provider: 'stub',
      };
    },
  };
}

function extractUserInput(prompt: string): string {
  const marker = 'User:';
  const idx = prompt.lastIndexOf(marker);
  if (idx < 0) return prompt;
  return prompt
    .slice(idx + marker.length)
    .replace('Output (JSON only):', '')
    .trim();
}

function pickState(
  input: string,
): 'CREATED' | 'VALIDATED' | 'SUBMITTED' | 'FAILED' | 'COMPLETED' | null {
  if (/\bcomplete|completed\b/i.test(input)) return 'COMPLETED';
  if (/\bsubmit|submitted|move forward|forward\b/i.test(input)) return 'SUBMITTED';
  if (/\bvalid|validated\b/i.test(input)) return 'VALIDATED';
  if (/\bfail|failed\b/i.test(input)) return 'FAILED';
  if (/\bcreate|created\b/i.test(input)) return 'CREATED';
  return null;
}
