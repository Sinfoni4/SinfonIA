import { runHarness } from '../harness/ai.harness.runner.js';

import { CORE_SCENARIOS } from './ai.core.scenarios.js';

/**
 * CORE ENGINE tests:
 * - generic parsing/normalization/guardrails
 * - infra/error classification
 * Does NOT include domain workflows.
 */
void runHarness({
  scenarios: CORE_SCENARIOS,
  filterTypes: ['core'],
  reportPath: 'reports/ai-core-report.json',
}).catch((err: unknown) => {
  console.error('[core-tests] fatal', err);
  process.exitCode = 1;
});
