import dotenv from 'dotenv';

import { EvaluationHarness } from '../src/ai/evaluation/evaluation.harness.js';
import { createOpenAIProvider } from '../src/ai/providers/openai.provider.js';

dotenv.config({ path: '.env.test' });
dotenv.config();

async function main() {
  const isNightly = process.argv.includes('--nightly') || process.argv.includes('--real');
  console.log('='.repeat(70));
  console.log(
    `SinfonIA AI Evaluation Harness — Phase 3D Golden Set (${isNightly ? 'NIGHTLY / REAL MODEL' : 'CI / DETERMINISTIC'})`,
  );
  console.log('='.repeat(70));

  let llmClient;
  if (isNightly && process.env.OPENAI_API_KEY) {
    console.log(`Connecting to real model: ${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}...`);
    llmClient = createOpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    });
  } else {
    console.log('Running deterministic golden set validation (CI Mode)...');
  }

  const harness = new EvaluationHarness({ llmClient });
  const { results, metrics } = await harness.runEvaluation();

  console.log('\n--- Scenario Execution Results ---');
  for (const r of results) {
    const icon = r.isCorrect ? '✅' : '❌';
    console.log(
      `${icon} [${r.scenarioId}] (${r.type}) "${r.input.slice(0, 45)}..." -> expected: ${r.expectedAction}, got: ${r.actualAction ?? 'none'} (${r.latencyMs}ms)`,
    );
  }

  console.log('\n' + '='.repeat(70));
  console.log('QUANTITATIVE EVALUATION METRICS:');
  console.log('='.repeat(70));
  console.log(`• Total Scenarios:              ${metrics.totalScenarios}`);
  console.log(
    `• Success Rate:                 ${(metrics.successRate * 100).toFixed(1)}% (Target: >= 95%)`,
  );
  console.log(
    `• Wrong Execution Rate:         ${(metrics.wrongExecutionRate * 100).toFixed(1)}% (Target: 0%)`,
  );
  console.log(
    `• Ambiguity Detection Rate:     ${(metrics.ambiguityDetectionRate * 100).toFixed(1)}% (Target: >= 95%)`,
  );
  console.log(
    `• Prompt Injection Block Rate:  ${(metrics.injectionBlockRate * 100).toFixed(1)}% (Target: 100%)`,
  );
  console.log(
    `• PII Leakage Rate:             ${(metrics.piiLeakRate * 100).toFixed(1)}% (Target: 0%)`,
  );
  console.log(
    `• Latency (Min / Avg / P95):    ${metrics.latency.minMs}ms / ${metrics.latency.avgMs}ms / ${metrics.latency.p95Ms}ms`,
  );
  console.log(
    `• Total Tokens Estimated:       ${metrics.tokens.totalTokens} (Prompt: ${metrics.tokens.totalPromptTokens}, Completion: ${metrics.tokens.totalCompletionTokens})`,
  );
  console.log(`• Estimated Cost:               $${metrics.tokens.estimatedCostUsd.toFixed(5)} USD`);
  console.log('='.repeat(70));

  if (metrics.gatePassed) {
    console.log('🎉 GATE 3D: PASSED — All quality and security criteria satisfied!\n');
    process.exit(0);
  } else {
    console.error('❌ GATE 3D: FAILED — Discrepancies detected:');
    for (const failure of metrics.failures) {
      console.error(`  - ${failure}`);
    }
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal evaluation runner error:', err);
  process.exit(1);
});
