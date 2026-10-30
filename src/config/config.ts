import dotenv from 'dotenv';
import { z } from 'zod';

/** An empty environment variable counts as not set. */
function unsetIfEmpty<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

// Centralized, validated configuration.
// If configuration is invalid, the process must fail fast (enterprise safety).
// quiet: dotenv would otherwise print an unstructured banner line to stdout.
dotenv.config({ quiet: true });

const ConfigSchema = z
  .object({
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
    // LLM provider: OpenAI, Azure OpenAI with a resource in an EU region, or Mistral (EU).
    LLM_PROVIDER: z.enum(['openai', 'azure', 'mistral']).default('openai'),
    AZURE_OPENAI_ENDPOINT: z.url().optional(),
    AZURE_OPENAI_API_KEY: z.string().min(1).optional(),
    AZURE_OPENAI_DEPLOYMENT: z.string().min(1).optional(),
    AZURE_OPENAI_API_VERSION: z.string().min(1).default('2024-10-21'),
    MISTRAL_API_KEY: z.string().min(1).optional(),
    MISTRAL_MODEL: z.string().min(1).default('mistral-small-latest'),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    AUTH_ISSUER: z.string().min(1).default('sinfonia'),
    AUTH_AUDIENCE: z.string().min(1).default('sinfonia-api'),
    AUTH_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    // Development only (F5): the login code is also returned to the caller.
    AUTH_DEV_SHOW_CODE: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    // Built dashboard served under /app (B2); absent: no dashboard.
    WEB_DIST_DIR: z.string().min(1).optional(),
    // Public address of the dashboard, for the links in emails (invitations); absent: code only.
    WEB_PUBLIC_URL: z
      .string()
      .url()
      .refine((v) => /^https?:\/\//.test(v), 'WEB_PUBLIC_URL must be an http(s) address')
      .optional(),
    // Email login (MF6): off until an email provider is chosen (D11); emails are simulated.
    AUTH_EMAIL_LOGIN: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    // Maximum size of a single practice attachment (default 10 MB).
    ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    // Attachment storage: local filesystem (default) or S3-compatible object storage (AWS S3, MinIO).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    // Default region: Milan, to keep attachments inside the EU.
    S3_REGION: z.string().min(1).default('eu-south-1'),
    S3_ENDPOINT: z.url().optional(),
    S3_FORCE_PATH_STYLE: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_SERVER_SIDE_ENCRYPTION: z.enum(['AES256', 'aws:kms']).optional(),
    // Background workers: durable scheduler tick and outbox delivery.
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
    OUTBOX_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
    // Shared secret for signing webhook deliveries; webhooks are not sent without it.
    OUTBOX_WEBHOOK_SECRET: z.string().min(32).optional(),
    // WhatsApp Business Cloud API: the channel is on only when all four values are set.
    // Empty means not configured (e.g. the dashboard demo turns WhatsApp off explicitly).
    WHATSAPP_ACCESS_TOKEN: unsetIfEmpty(z.string().min(1).optional()),
    WHATSAPP_PHONE_NUMBER_ID: unsetIfEmpty(z.string().min(1).optional()),
    WHATSAPP_APP_SECRET: unsetIfEmpty(z.string().min(1).optional()),
    WHATSAPP_VERIFY_TOKEN: unsetIfEmpty(z.string().min(16).optional()),
    WHATSAPP_API_VERSION: z.string().min(2).default('v21.0'),
    // HTTP request limits per minute: per user, per user on /ai/execute, per tenant.
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_AI_PER_MINUTE: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_TENANT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    // Login, token and invitation requests per address and minute (MF6).
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    // AI traces older than this are deleted (they hold no prompt text, only metadata).
    AI_TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  })
  .refine(
    (c) =>
      c.LLM_PROVIDER !== 'azure' ||
      Boolean(c.AZURE_OPENAI_ENDPOINT && c.AZURE_OPENAI_API_KEY && c.AZURE_OPENAI_DEPLOYMENT),
    {
      message:
        'LLM_PROVIDER=azure needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT',
      path: ['LLM_PROVIDER'],
    },
  )
  .refine((c) => !c.AUTH_DEV_SHOW_CODE || c.NODE_ENV === 'development', {
    // A login code returned to the caller would make the email useless as a proof.
    message: 'AUTH_DEV_SHOW_CODE is allowed only with NODE_ENV=development',
    path: ['AUTH_DEV_SHOW_CODE'],
  })
  .refine((c) => !(c.AUTH_EMAIL_LOGIN && c.NODE_ENV === 'production'), {
    // The login codes would go nowhere: no email provider is configured yet (D11).
    message: 'AUTH_EMAIL_LOGIN needs a real email provider, not available yet',
    path: ['AUTH_EMAIL_LOGIN'],
  })
  .refine((c) => c.LLM_PROVIDER !== 'mistral' || Boolean(c.MISTRAL_API_KEY), {
    message: 'LLM_PROVIDER=mistral needs MISTRAL_API_KEY',
    path: ['LLM_PROVIDER'],
  })
  .refine((c) => c.STORAGE_DRIVER !== 's3' || Boolean(c.S3_BUCKET), {
    message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
    path: ['S3_BUCKET'],
  })
  .refine(
    (c) => {
      const set = [
        c.WHATSAPP_ACCESS_TOKEN,
        c.WHATSAPP_PHONE_NUMBER_ID,
        c.WHATSAPP_APP_SECRET,
        c.WHATSAPP_VERIFY_TOKEN,
      ].filter(Boolean).length;
      return set === 0 || set === 4;
    },
    {
      message:
        'WhatsApp needs WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN together',
      path: ['WHATSAPP_ACCESS_TOKEN'],
    },
  );

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
