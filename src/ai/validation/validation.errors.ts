export class ValidationError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, args?: { code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'ValidationError';
    this.code = args?.code ?? 'VALIDATION_ERROR';
    this.details = args?.details;
  }
}

export class ContextValidationError extends ValidationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'VALIDATION_ERROR', details });
    this.name = 'ContextValidationError';
  }
}

export class PreExecutionValidationError extends ValidationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'VALIDATION_ERROR', details });
    this.name = 'PreExecutionValidationError';
  }
}
