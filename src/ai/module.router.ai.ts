type ModuleName = string;

/**
 * Shadow-mode AI routing hint (heuristic only — no LLM).
 * Does not affect real routing; use only for logging / observability.
 */
export function aiSuggestModule(input: string): ModuleName | null {
  const lower = input.toLowerCase();

  if (lower.includes('pratica') || lower.includes('concerto')) {
    return 'music';
  }

  if (lower.includes('demo')) {
    return 'demo';
  }

  return null;
}
