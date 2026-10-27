/**
 * PII Minimization & Data Masking Engine.
 *
 * Anonymizes/masks personally identifiable information (PII) before external
 * LLM egress, ensuring compliance with GDPR, data minimization principles, and
 * confidential data retention requirements.
 *
 * Supports bidirectional masking/unmasking so that localized business entities
 * (e.g. fiscal codes, contact numbers) are preserved in the application while
 * never being transmitted in plain text to the LLM.
 */

export type PIIType = 'CODICE_FISCALE' | 'IBAN' | 'CREDIT_CARD' | 'EMAIL' | 'PHONE';

export interface MaskPIIResult {
  maskedText: string;
  piiMap: Map<string, string>;
  hasPII: boolean;
  detectedTypes: PIIType[];
}

// Regex patterns for sensitive Italian & European identifiers
const PII_PATTERNS: Array<{ type: PIIType; regex: RegExp; placeholderPrefix: string }> = [
  // Italian Codice Fiscale (16 alphanumeric characters: 6 letters, 2 digits, 1 letter, 2 digits, 1 letter, 3 digits, 1 letter)
  {
    type: 'CODICE_FISCALE',
    regex: /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi,
    placeholderPrefix: 'CODICE_FISCALE',
  },
  // International Bank Account Number (IBAN - IT has 27 chars, European 15-34 chars)
  {
    type: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi,
    placeholderPrefix: 'IBAN',
  },
  // Credit card numbers (13 to 19 digits, with or without spaces/hyphens)
  {
    type: 'CREDIT_CARD',
    regex: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
    placeholderPrefix: 'CARD_NUMBER',
  },
  // Email addresses
  {
    type: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
    placeholderPrefix: 'EMAIL',
  },
  // Italian phone numbers (+39, mobile starting with 3, landlines starting with 0)
  {
    type: 'PHONE',
    regex: /(?:\+39\s?)?(?:3\d{2}[-.\s]?\d{6,7}|0\d{1,3}[-.\s]?\d{5,8})\b/g,
    placeholderPrefix: 'PHONE',
  },
];

/**
 * Scans text and replaces identified PII with indexed token placeholders (e.g. [CODICE_FISCALE_1]).
 * Returns the masked text alongside a reverse lookup map for unmasking post-LLM generation.
 */
export function maskPII(text: string): MaskPIIResult {
  let masked = text;
  const piiMap = new Map<string, string>();
  const detectedTypes = new Set<PIIType>();
  const typeCounters = new Map<PIIType, number>();

  for (const { type, regex, placeholderPrefix } of PII_PATTERNS) {
    masked = masked.replace(regex, (match) => {
      // Avoid masking inside existing placeholders
      if (match.startsWith('[') && match.endsWith(']')) {
        return match;
      }

      detectedTypes.add(type);
      const counter = (typeCounters.get(type) ?? 0) + 1;
      typeCounters.set(type, counter);

      const placeholder = `[${placeholderPrefix}_${counter}]`;
      piiMap.set(placeholder, match);
      return placeholder;
    });
  }

  return {
    maskedText: masked,
    piiMap,
    hasPII: piiMap.size > 0,
    detectedTypes: Array.from(detectedTypes),
  };
}

/**
 * Restores original sensitive values in the LLM response using the reverse lookup map.
 */
export function unmaskPII(text: string, piiMap: Map<string, string>): string {
  if (piiMap.size === 0) return text;

  let unmasked = text;
  for (const [placeholder, originalValue] of piiMap.entries()) {
    unmasked = unmasked.replaceAll(placeholder, originalValue);
  }
  return unmasked;
}

/**
 * Deeply unmasks any string fields in an object (e.g. InterpreterOutput).
 */
export function unmaskObjectPII<T>(obj: T, piiMap: Map<string, string>): T {
  if (piiMap.size === 0 || obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (typeof obj === 'string') {
    return unmaskPII(obj, piiMap) as unknown as T;
  }

  if (Array.isArray(obj)) {
    const list: unknown[] = (obj as unknown[]).map((item) => unmaskObjectPII(item, piiMap));
    return list as T;
  }

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      result[key] = unmaskPII(val, piiMap);
    } else if (typeof val === 'object' && val !== null) {
      result[key] = unmaskObjectPII(val, piiMap);
    } else {
      result[key] = val;
    }
  }

  return result as T;
}

/**
 * Redacts PII for safe persistent logging without retaining reverse mapping.
 */
export function redactPIIForLogging(text: string): string {
  let redacted = text;
  for (const { type, regex } of PII_PATTERNS) {
    redacted = redacted.replace(regex, `[REDACTED_${type}]`);
  }
  return redacted;
}
