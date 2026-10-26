import { CORE_SCENARIOS } from './core/ai.core.scenarios.js';
import { ARTIST_PRACTICE_SCENARIOS } from './domain/artist-practice.scenarios.js';
import { runHarness } from './harness/ai.harness.runner.js';

async function main() {
  const core = await runHarness({
    scenarios: CORE_SCENARIOS,
    filterTypes: ['core'],
    reportPath: 'reports/ai-core-report.json',
  });
  const domain = await runHarness({
    scenarios: ARTIST_PRACTICE_SCENARIOS,
    filterTypes: ['domain'],
    reportPath: 'reports/ai-domain-report.json',
  });

  const combined = {
    core: core.core,
    domain: domain.domain,
  };
  await (
    await import('node:fs/promises')
  ).writeFile('reports/ai-behavior-report.json', JSON.stringify(combined, null, 2), 'utf8');
  console.log('\nAI PRODUCT REPORT\n');
  console.log(JSON.stringify(combined, null, 2));
}

void main().catch((err: unknown) => {
  console.error('[test:all] fatal', err);
  process.exitCode = 1;
});
