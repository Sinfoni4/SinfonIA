export function validateTestEnv(strict: boolean): string[] {
  const errors: string[] = [];

  if (strict) {
    if (process.env.ENABLE_LLM !== 'true') {
      errors.push('ENABLE_LLM must be true');
    }
    if (!process.env.OPENAI_API_KEY) {
      errors.push('OPENAI_API_KEY is missing');
    }
    if (!process.env.DATABASE_URL) {
      errors.push('DATABASE_URL is missing');
    }
  }

  return errors;
}
