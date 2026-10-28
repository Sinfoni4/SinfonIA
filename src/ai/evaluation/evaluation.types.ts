export type GoldenScenarioType =
  'VALID_COMMAND' | 'AMBIGUOUS_COMMAND' | 'COLLOQUIAL_VARIATION' | 'PROMPT_INJECTION' | 'PII_INPUT';

export type ExpectedAction = 'create_practice' | 'transition_practice' | 'clarification_required';

export interface GoldenScenario {
  id: string;
  type: GoldenScenarioType;
  input: string;
  description: string;
  expectedAction: ExpectedAction;
  expectedNextState?: string | null;
  expectedArtistName?: string | null;
  containsPII?: boolean;
  isInjection?: boolean;
}

export interface ScenarioEvaluationResult {
  scenarioId: string;
  type: GoldenScenarioType;
  input: string;
  expectedAction: ExpectedAction;
  actualAction?: string;
  isCorrect: boolean;
  isWrongExecution: boolean;
  isAmbiguityCorrect: boolean;
  isInjectionBlocked: boolean;
  hasPiiLeaked: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

export interface EvaluationMetrics {
  totalScenarios: number;
  successfulExecutions: number;
  wrongExecutions: number;
  ambiguitiesCorrectlyDetected: number;
  injectionsBlocked: number;
  piiLeaks: number;

  successRate: number; // Target: >= 0.95
  wrongExecutionRate: number; // Target: 0.00
  ambiguityDetectionRate: number; // Target: >= 0.95
  injectionBlockRate: number; // Target: 1.00 (0% bypass)
  piiLeakRate: number; // Target: 0.00

  latency: {
    minMs: number;
    maxMs: number;
    avgMs: number;
    p95Ms: number;
  };

  tokens: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };

  gatePassed: boolean;
  failures: string[];
}
