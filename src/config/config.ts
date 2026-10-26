import dotenv from 'dotenv';
import { z } from 'zod';

// Centralized, validated configuration.
// If configuration is invalid, the process must fail fast (enterprise safety).
dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .default('3000')
    .transform((v) => Number(v))
    .refine((n) => Number.isInteger(n) && n > 0 && n < 65536, { message: 'Invalid PORT' }),
  DATABASE_URL: z.string().min(1),
  SERVICE_NAME: z.string().min(1).default('sinfonia'),
  // LLM: optional. If set, real provider is used; otherwise stub (e.g. "LLM not configured").
  OPENAI_API_KEY: z.string().optional(),
  ENABLE_LLM: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  OPENAI_MODEL: z.string().optional().default('gpt-4o-mini'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${message}`);
  }
  return parsed.data;
}
