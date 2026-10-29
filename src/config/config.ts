import dotenv from 'dotenv';
import { z } from 'zod';

// Centralized, validated configuration.
// If configuration is invalid, the process must fail fast (enterprise safety).
dotenv.config();

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
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    AUTH_ISSUER: z.string().min(1).default('sinfonia'),
    AUTH_AUDIENCE: z.string().min(1).default('sinfonia-api'),
    AUTH_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
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
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
    WHATSAPP_API_VERSION: z.string().min(2).default('v21.0'),
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
