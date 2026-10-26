/**
 * Validation and sanitization for AI endpoint input.
 * - Reject empty or whitespace-only input
 * - Enforce max length to avoid abuse and token limits
 * - Basic sanitization (trim, strip control characters)
 */

const MAX_INPUT_LENGTH = 10_000;
// eslint-disable-next-line no-control-regex -- intentional: strip control characters from user input
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export type AiInputValidationResult =
  { ok: true; value: string } | { ok: false; code: string; message: string };

export function validateAiInput(raw: unknown): AiInputValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_INPUT', message: 'Input must be a string' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'EMPTY_INPUT', message: 'Input cannot be empty' };
  }

  if (trimmed.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      code: 'INPUT_TOO_LONG',
      message: `Input must be at most ${MAX_INPUT_LENGTH} characters`,
    };
  }

  const sanitized = trimmed.replace(CONTROL_CHAR_REGEX, '');
  return { ok: true, value: sanitized };
}
