import type { AIScenario } from '../harness/ai.harness.types.js';

/**
 * DOMAIN scenarios for Artist Practice.
 * These are business-relevant and intentionally exclude generic/legacy noise.
 */
export const ARTIST_PRACTICE_SCENARIOS: AIScenario[] = [
  {
    id: 'artist-01',
    type: 'domain',
    category: 'NATURAL_INPUT',
    input: 'crea pratica per Mario Rossi',
    expectedBehavior: 'SUCCESS',
    expectedNextState: 'CREATED',
  },
  {
    id: 'artist-02',
    type: 'domain',
    category: 'NATURAL_INPUT',
    input: 'valida la pratica di Mario Rossi',
    expectedBehavior: 'SUCCESS',
    expectedNextState: 'VALIDATED',
  },
  {
    id: 'artist-03',
    type: 'domain',
    category: 'NATURAL_INPUT',
    input: 'completa la pratica di Mario Rossi',
    expectedBehavior: 'SUCCESS',
    expectedNextState: 'COMPLETED',
  },
  {
    id: 'artist-invalid-01',
    type: 'domain',
    category: 'NATURAL_INPUT',
    input: 'completa la pratica di Mario Rossi',
    expectedBehavior: 'ERROR',
    expectedNextState: 'COMPLETED',
  },
  {
    id: 'artist-amb-01',
    type: 'domain',
    category: 'AMBIGUOUS_INPUT',
    input: 'valida la pratica di Mario Rossi',
    expectedBehavior: 'AMBIGUOUS',
  },
];
