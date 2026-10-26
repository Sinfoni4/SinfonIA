import { ALLOWED_TRANSITIONS, type PRACTICE_STATES } from '../../core/workflow/state-machine.js';

import type { InterpreterOutput } from '../interpreter/interpreter.types.js';

type CanonicalStatus = (typeof PRACTICE_STATES)[number];

const STATUS_MAP: Record<string, CanonicalStatus> = {
  created: 'CREATED',
  new: 'CREATED',
  validated: 'VALIDATED',
  completed: 'COMPLETED',
  submitted: 'SUBMITTED',
  failed: 'FAILED',
};

const NEXT_STATE_MAP: Record<string, CanonicalStatus> = {
  created: 'CREATED',
  new: 'CREATED',
  validated: 'VALIDATED',
  completed: 'COMPLETED',
  submitted: 'SUBMITTED',
  failed: 'FAILED',
};

const ALLOWED_TRANSITION_KEYS = new Set(
  Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, targets]) =>
    targets.map((to) => `${from}->${to}`),
  ),
);

function normalizeWord(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const normalized = input.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStatus(input: string | undefined | null): CanonicalStatus | undefined {
  const word = normalizeWord(input);
  if (!word) return undefined;
  return STATUS_MAP[word];
}

function normalizeNextState(input: string): CanonicalStatus | undefined {
  const word = normalizeWord(input);
  if (!word) return undefined;
  return NEXT_STATE_MAP[word];
}

function normalizeArtistName(
  input: string | undefined | null,
): { original: string; key: string } | null {
  if (!input) return null;
  const original = input.trim();
  if (original.length === 0) return null;
  return { original, key: original.toLowerCase() };
}

export class NormalizationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationValidationError';
  }
}

export class NormalizerService {
  normalize(input: InterpreterOutput): InterpreterOutput {
    const canonicalNextState = normalizeNextState(input.nextState);
    if (!canonicalNextState) {
      throw new NormalizationValidationError(`Invalid nextState: ${input.nextState}`);
    }

    if (input.action === 'create_practice') {
      const artist = normalizeArtistName(input.artistName);
      if (!artist) {
        throw new NormalizationValidationError('Invalid artistName: must be a non-empty string');
      }
      const output: InterpreterOutput = {
        action: 'create_practice',
        filters: {
          practiceId: null,
          status: null,
          name: null,
        },
        artistName: artist.original,
        nextState: 'CREATED',
      };

      console.log('[ai-flow]', { step: 'normalize', input, output });
      return output;
    }

    const canonicalStatus = normalizeStatus(input.filters.status);
    if (input.filters.status && !canonicalStatus) {
      throw new NormalizationValidationError(`Invalid status filter: ${input.filters.status}`);
    }

    const normalizedName = normalizeWord(input.filters.name);
    const hasPracticeId =
      typeof input.filters.practiceId === 'string' && input.filters.practiceId.trim().length > 0;

    // If practiceId is explicit, skip name filtering.
    const finalName = hasPracticeId ? undefined : normalizedName;

    // When targeting COMPLETED by name, do not force a source-status filter.
    // This lets the deterministic pipeline resolve the candidate, and validation/workflow enforce correctness.
    const shouldDropStatusFilter = Boolean(finalName) && canonicalNextState === 'COMPLETED';

    if (canonicalStatus) {
      const transitionKey = `${canonicalStatus}->${canonicalNextState}`;
      if (!ALLOWED_TRANSITION_KEYS.has(transitionKey)) {
        throw new NormalizationValidationError(`Invalid transition: ${transitionKey}`);
      }
    }

    const output: InterpreterOutput = {
      action: input.action,
      filters: {
        practiceId: input.filters.practiceId ?? null,
        status: shouldDropStatusFilter ? null : (canonicalStatus ?? null),
        name: finalName ?? null,
      },
      artistName: null,
      nextState: canonicalNextState,
    };

    console.log('[ai-flow]', { step: 'normalize', input, output });
    return output;
  }
}
