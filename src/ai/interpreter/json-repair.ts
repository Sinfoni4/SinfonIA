/**
 * Resilient JSON repair utility for LLM outputs.
 * Handles common LLM quirks: markdown blocks, unescaped characters,
 * trailing commas, single-quoted strings, unquoted keys, and unclosed brackets.
 */

export function repairJsonString(raw: string): string {
  let text = raw.trim();

  // 1. Strip markdown code fences (```json ... ``` or ``` ...)
  const codeBlockMatch = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(text);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  // 2. Extract outermost JSON object { ... } if text contains conversational pre/post-amble
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1).trim();
  } else if (firstBrace !== -1 && lastBrace === -1) {
    // Unclosed brace
    text = text.slice(firstBrace).trim() + '}';
  }

  // 3. Remove trailing commas before closing braces/brackets (e.g. { "a": 1, } -> { "a": 1 })
  text = text.replace(/,(\s*[}\]])/g, '$1');

  // 4. Normalize single-quoted property keys to double-quotes: {'key': -> {"key":
  text = text.replace(/'([a-zA-Z0-9_$]+)'\s*:/g, '"$1":');

  // 5. Normalize unquoted property keys: { key: -> {"key":
  text = text.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

  return text;
}

export function parseAndRepairJSON(raw: string): unknown {
  if (!raw || typeof raw !== 'string') return null;

  // Attempt 1: Direct standard parse
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Continue to repair
  }

  // Attempt 2: Repaired string parse
  try {
    const repaired = repairJsonString(raw);
    return JSON.parse(repaired) as unknown;
  } catch {
    // Attempt 3: Aggressive fallback for single-quoted strings: 'val' -> "val"
    try {
      const aggressive = repairJsonString(raw).replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
      return JSON.parse(aggressive) as unknown;
    } catch {
      return null;
    }
  }
}
