import dotenv from 'dotenv';
import { z } from 'zod';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** One TRUST_PROXY entry: an IPv4 or IPv6 address, optionally with a CIDR prefix, or a name. */
function isProxyAddress(entry: string): boolean {
  if (['loopback', 'linklocal', 'uniquelocal'].includes(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  if (IPV4.test(address)) return prefix === undefined || /^(3[0-2]|[12]?\d)$/.test(prefix);
  const ipv6 = address.includes(':') && /^[0-9a-f:.]+$/i.test(address);
  return ipv6 && (prefix === undefined || /^(12[0-8]|1[01]\d|[1-9]?\d)$/.test(prefix));
}

/** The trusted proxies for Fastify's trustProxy option; false when none is configured. */
export function trustedProxies(config: { TRUST_PROXY?: string }): string[] | false {
  if (!config.TRUST_PROXY) return false;
  return config.TRUST_PROXY.split(',').map((p) => p.trim());
}

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
    // Network address of the HTTP server. Absent: this PC only (127.0.0.1) when login codes are
    // shown on screen (AUTH_DEV_SHOW_CODE), otherwise every interface (0.0.0.0).
    HOST: z.string().trim().min(1).optional(),
    // Reverse proxies in front of the server (nginx on the same machine: 127.0.0.1), comma-separated
    // IP addresses or CIDR ranges, or loopback / linklocal / uniquelocal. Only their
    // X-Forwarded-For is believed, so rate limits count the real client address. Absent: none (the
    // address of the connection is the client's).
    TRUST_PROXY: unsetIfEmpty(
      z
        .string()
        .trim()
        .refine((v) => v.split(',').every((p) => isProxyAddress(p.trim())), {
          message:
            'TRUST_PROXY must list IP addresses, CIDR ranges, loopback, linklocal or uniquelocal',
        })
        .optional(),
    ),
    // Public address of the dashboard, for the links in emails (invitations); absent: code only.
    WEB_PUBLIC_URL: z
      .string()
      .url()
      .refine((v) => /^https?:\/\//.test(v), 'WEB_PUBLIC_URL must be an http(s) address')
      .optional(),
    // Email login (MF6): off until an email provider is chosen (D11); emails are simulated.
    // Telegram Mini App (/app/tg): login with the data Telegram signs, for linked accounts. It
    // needs no email provider, so it is allowed in production; it needs TELEGRAM_BOT_TOKEN.
    // Demo (staging only): «/start demo» gives an unlinked Telegram account its own account in
    // the «SinfonIA Demo» organization, with invented data deleted after a week.
    DEMO_ACCESS: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    TELEGRAM_MINIAPP: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    AUTH_EMAIL_LOGIN: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    // Transactional emails (login codes, invitations) through SMTP (D11). All four of SMTP_HOST,
    // SMTP_USER, SMTP_PASSWORD and EMAIL_FROM together; absent: simulated, nothing leaves the server.
    SMTP_HOST: unsetIfEmpty(z.string().trim().min(1).optional()),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    // TLS from the first byte (port 465); absent: on for 465, STARTTLS required otherwise.
    SMTP_SECURE: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
    SMTP_USER: unsetIfEmpty(z.string().trim().min(1).optional()),
    SMTP_PASSWORD: unsetIfEmpty(z.string().min(1).optional()),
    // Sender shown to the person, e.g. "SinfonIA <noreply@synfonia.it>".
    EMAIL_FROM: unsetIfEmpty(z.string().trim().min(3).optional()),
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
    // Folder of the encrypted backups (npm run db:backup): the console shows the last one.
    BACKUP_DIR: z.string().min(1).optional(),
    // B4: the nightly backup made by the application, at this time (HH:MM, local); unset: off.
    BACKUP_NIGHTLY_AT: unsetIfEmpty(
      z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'BACKUP_NIGHTLY_AT must be HH:MM')
        .optional(),
    ),
    // The 32-byte key of the backups (base64 or hex), kept by the owner also outside this PC.
    BACKUP_KEY: unsetIfEmpty(z.string().optional()),
    // The database read by the nightly backup (default DATABASE_URL); it needs read access to
    // every table, migrations included.
    BACKUP_SOURCE_URL: unsetIfEmpty(z.string().optional()),
    // How many nightly backups are kept (the newest one checked with a restore is kept as well).
    BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
    // AGX-07: euro per unit of usage, JSON (e.g. {"OCR_PAGES":0.002}); only for the internal cost
    // shown in the platform console. Checked at start: a wrong value stops it.
    USAGE_RATES: unsetIfEmpty(z.string().optional()),
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
    // AGX-08: background reads of a document whose first read failed, before the manual check.
    // Never more than OUTBOX_MAX_ATTEMPTS.
    OCR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
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
  .refine((c) => !(c.DEMO_ACCESS && c.NODE_ENV === 'production'), {
    // Anyone with the link gets an account: never next to real organizations.
    message: 'DEMO_ACCESS is allowed only outside production',
    path: ['DEMO_ACCESS'],
  })
  .refine((c) => !(c.AUTH_EMAIL_LOGIN && c.NODE_ENV === 'production' && !c.SMTP_HOST), {
    // Without SMTP the login codes would go nowhere (the simulated sender keeps them in memory).
    message:
      'AUTH_EMAIL_LOGIN in production needs SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM',
    path: ['AUTH_EMAIL_LOGIN'],
  })
  .refine(
    (c) => {
      const set = [c.SMTP_HOST, c.SMTP_USER, c.SMTP_PASSWORD, c.EMAIL_FROM].filter(Boolean).length;
      return set === 0 || set === 4;
    },
    {
      message: 'SMTP needs SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM together',
      path: ['SMTP_HOST'],
    },
  )
  .refine((c) => c.LLM_PROVIDER !== 'mistral' || Boolean(c.MISTRAL_API_KEY), {
    message: 'LLM_PROVIDER=mistral needs MISTRAL_API_KEY',
    path: ['LLM_PROVIDER'],
  })
  .refine((c) => !c.BACKUP_NIGHTLY_AT || Boolean(c.BACKUP_DIR && c.BACKUP_KEY), {
    message: 'BACKUP_NIGHTLY_AT needs BACKUP_DIR and BACKUP_KEY',
    path: ['BACKUP_NIGHTLY_AT'],
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

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

/** The SMTP server for transactional emails, when configured (all four values are checked). */
export function smtpSettings(config: AppConfig): SmtpSettings | undefined {
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM, SMTP_PORT } = config;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD || !EMAIL_FROM) return undefined;
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: config.SMTP_SECURE ?? SMTP_PORT === 465,
    user: SMTP_USER,
    password: SMTP_PASSWORD,
    from: EMAIL_FROM,
  };
}

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
