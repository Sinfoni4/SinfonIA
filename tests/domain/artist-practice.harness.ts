import { runHarness } from '../harness/ai.harness.runner.js';

import { ARTIST_PRACTICE_SCENARIOS } from './artist-practice.scenarios.js';

/**
 * DOMAIN tests (Artist Practice):
 * We validate the full business workflow and compute business KPIs.
 */
void runHarness({
  scenarios: ARTIST_PRACTICE_SCENARIOS,
  filterTypes: ['domain'],
  reportPath: 'reports/ai-domain-report.json',
}).catch((err: unknown) => {
  console.error('[domain-tests] fatal', err);
  process.exitCode = 1;
});
