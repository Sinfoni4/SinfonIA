export type TestType = 'core' | 'domain' | 'invalid';

export type ScenarioCategory =
  'PERFECT_INPUT' | 'NATURAL_INPUT' | 'AMBIGUOUS_INPUT' | 'NOISY_INPUT' | 'MALICIOUS_INPUT';

export type ExpectedBehavior = 'SUCCESS' | 'AMBIGUOUS' | 'ERROR';

export interface AIScenario {
  id: string;
  type: TestType;
  category: ScenarioCategory;
  input: string;
  expectedBehavior: ExpectedBehavior;
  expectedNextState?: 'CREATED' | 'VALIDATED' | 'SUBMITTED' | 'FAILED' | 'COMPLETED';
}

export type Classification =
  | 'SUCCESS'
  | 'AMBIGUOUS'
  | 'VALIDATION_ERROR'
  | 'EXECUTION_ERROR'
  | 'WRONG_INTERPRETATION'
  | 'INFRASTRUCTURE_ERROR';

export type InfrastructureType = 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK';

export type InfrastructureInfo = {
  type: InfrastructureType;
  retries: number;
  finalFailure: boolean;
};

export interface ScenarioResult {
  scenarioId: string;
  type: TestType;
  category: ScenarioCategory;
  input: string;
  expectedBehavior: ExpectedBehavior;
  expectedNextState?: string;
  interpreterOutput?: unknown;
  executionResult?: unknown;
  httpResponse?: { statusCode: number; body: unknown };
  classification: Classification;
  notes?: string;
  infrastructure?: InfrastructureInfo;
}
