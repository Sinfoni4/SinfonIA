export type ErrorDetails = {
  message: string;
  code?: string;
  name?: string;
};

export function describeError(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    const rawCode = 'code' in error ? (error as { code?: unknown }).code : undefined;
    const code =
      typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;

    return { message: error.message, code, name: error.name };
  }

  return { message: String(error) };
}

export function errorMessage(error: unknown): string {
  return describeError(error).message;
}

/** Safe, non-payload error label for logs (name + optional error code). */
export function errorLabel(error: unknown): string {
  const details = describeError(error);
  return [details.name, details.code].filter(Boolean).join(':') || 'Error';
}
