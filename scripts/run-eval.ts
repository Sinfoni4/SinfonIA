/**
 * AI evaluation on the golden set.
 *
 *   npm run ai:eval                 pipeline mode: simulated LLM, checks the deterministic pipeline
 *   npm run ai:eval:nightly         model mode: the real provider (OpenAI, Azure OpenAI or Mistral)
 *
 * Model mode needs ENABLE-independent credentials: OPENAI_API_KEY, LLM_PROVIDER=azure with the
 * AZURE_OPENAI_* variables, or LLM_PROVIDER=mistral with MISTRAL_API_KEY (and MISTRAL_MODEL).
 * The cost estimate uses gpt-4o-mini prices whatever the provider. --max-cost-usd caps the spend (default $0.10); the report is written
 * to reports/ai-eval-<mode>.json (an artifact of the nightly CI job).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

import { EvaluationHarness } from '../src/ai/evaluation/evaluation.harness.js';
import {
  createAzureOpenAIProvider,
  createMistralProvider,
  createOpenAIProvider,
  DEFAULT_MISTRAL_MODEL,
} from '../src/ai/providers/openai.provider.js';

import type { LLMClient } from '../src/ai/interpreter/interpreter.service.js';

dotenv.config({ path: '.env.test', quiet: true });
dotenv.config({ quiet: true });

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function realProvider(): LLMClient | null {
  const env = process.env;
  if (
    env.LLM_PROVIDER === 'azure' &&
    env.AZURE_OPENAI_ENDPOINT &&
    env.AZURE_OPENAI_API_KEY &&
    env.AZURE_OPENAI_DEPLOYMENT
  ) {
    return {
      ...createAzureOpenAIProvider({
        endpoint: env.AZURE_OPENAI_ENDPOINT,
        apiKey: env.AZURE_OPENAI_API_KEY,
        deployment: env.AZURE_OPENAI_DEPLOYMENT,
        apiVersion: env.AZURE_OPENAI_API_VERSION,
      }),
      model: env.AZURE_OPENAI_DEPLOYMENT,
    };
  }
  if (env.LLM_PROVIDER === 'mistral' && env.MISTRAL_API_KEY) {
    const model = env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL;
    return createMistralProvider({ apiKey: env.MISTRAL_API_KEY, model });
  }
  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_MODEL ?? 'gpt-4o-mini';
    return { ...createOpenAIProvider({ apiKey: env.OPENAI_API_KEY, model }), model };
  }
  return null;
}

async function main() {
  const wantsModel = process.argv.includes('--nightly') || process.argv.includes('--real');
  const maxCostUsd = Number(argValue('--max-cost-usd') ?? 0.1);

  const llmClient = wantsModel ? realProvider() : null;
  if (wantsModel && !llmClient) {
    console.error(
      'Model mode requested but no provider is configured (OPENAI_API_KEY or AZURE_OPENAI_*).',
    );
    process.exit(2);
  }

  const harness = new EvaluationHarness({ ...(llmClient ? { llmClient, maxCostUsd } : {}) });
  console.log('='.repeat(70));
  console.log(
    harness.mode === 'model'
      ? `SinfonIA AI evaluation — MODEL (${llmClient?.model ?? 'unknown'}), budget $${maxCostUsd}`
      : 'SinfonIA AI evaluation — PIPELINE (simulated LLM: measures the pipeline, not the model)',
  );
  console.log('='.repeat(70));

  const { results, metrics } = await harness.runEvaluation();

  for (const r of results) {
    const reason = r.isCorrect ? '' : `  ← ${r.detail ?? r.error ?? 'failed'}`;
    console.log(
      `${r.isCorrect ? '✅' : '❌'} [${r.scenarioId}] "${r.input.slice(0, 50)}" -> ${r.actualAction ?? 'none'} (${r.latencyMs}ms)${reason}`,
    );
  }

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Mode / model:            ${metrics.mode} / ${metrics.model}`);
  console.log(`Scenarios:               ${metrics.executedScenarios}/${metrics.totalScenarios}`);
  for (const [type, { correct, total }] of Object.entries(metrics.byType)) {
    console.log(`  ${type.padEnd(22)} ${correct}/${total}`);
  }
  console.log(`Success rate:            ${pct(metrics.successRate)} (target >= 95%)`);
  console.log(`Wrong executions:        ${pct(metrics.wrongExecutionRate)} (target 0%)`);
  console.log(`Ambiguity detection:     ${pct(metrics.ambiguityDetectionRate)} (target >= 95%)`);
  console.log(`Injection blocked:       ${pct(metrics.injectionBlockRate)} (target 100%)`);
  console.log(`Personal data leaks:     ${metrics.piiLeaks} (target 0)`);
  console.log(
    `Latency min/avg/p95:     ${metrics.latency.minMs} / ${metrics.latency.avgMs} / ${metrics.latency.p95Ms} ms`,
  );
  console.log(
    `Tokens:                  ${metrics.tokens.totalTokens} (prompt ${metrics.tokens.totalPromptTokens}, completion ${metrics.tokens.totalCompletionTokens})`,
  );
  console.log(`Estimated cost:          $${metrics.tokens.estimatedCostUsd.toFixed(5)}`);
  console.log('='.repeat(70));

  const reportPath = path.join('reports', `ai-eval-${metrics.mode}.json`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), metrics, results }, null, 2)}\n`,
  );
  console.log(`Report: ${reportPath}`);

  if (metrics.misses.length > 0) {
    console.log('Safe misses (asked instead of acting, within the success threshold):');
    for (const miss of metrics.misses) console.log(`  - ${miss}`);
  }
  if (metrics.gatePassed) {
    console.log('GATE PASSED\n');
    return;
  }
  console.error('GATE FAILED:');
  for (const failure of metrics.failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('Evaluation runner error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
