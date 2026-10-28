/** Invalid compliance deadline input (unknown category, impossible date, empty title...). */
export class ComplianceValidationError extends Error {
  readonly code = 'INVALID_DEADLINE';
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ComplianceValidationError';
  }
}
