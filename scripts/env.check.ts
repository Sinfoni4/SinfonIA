import fs from 'node:fs';

/**
 * Development preflight.
 *
 * This script validates the local environment without creating or rewriting files.
 * It never copies values between `.env` and `.env.test`.
 */
function parseDotenv(contents: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values.set(key, value);
  }

  return values;
}

function readEnvFile(filePath: string): Map<string, string> {
  if (!fs.existsSync(filePath)) return new Map();
  return parseDotenv(fs.readFileSync(filePath, 'utf8'));
}

const envFile = readEnvFile('.env');
const errors: string[] = [];
const warnings: string[] = [];

function getValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.trim().length > 0) return fromProcess.trim();

  const fromFile = envFile.get(key);
  if (fromFile && fromFile.trim().length > 0) return fromFile.trim();

  return undefined;
}

if (!fs.existsSync('.env') && !process.env.DATABASE_URL) {
  errors.push('`.env` is missing and DATABASE_URL is not exported.');
  errors.push('Create it from the template: cp .env.example .env');
}

const databaseUrl = getValue('DATABASE_URL');
if (!databaseUrl) {
  errors.push('DATABASE_URL is required.');
} else if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) {
  errors.push('DATABASE_URL must use the postgresql:// or postgres:// scheme.');
}

const telegramToken = getValue('TELEGRAM_BOT_TOKEN');
if (!telegramToken) {
  warnings.push('TELEGRAM_BOT_TOKEN is not set: the Telegram bot will stay disabled.');
} else if (!/^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) {
  warnings.push('TELEGRAM_BOT_TOKEN does not look like a valid Bot API token.');
}

const enableLlm = (getValue('ENABLE_LLM') ?? 'false').toLowerCase();
if ((enableLlm === 'true' || enableLlm === '1') && !getValue('OPENAI_API_KEY')) {
  errors.push('ENABLE_LLM is enabled but OPENAI_API_KEY is missing.');
}

if (errors.length > 0) {
  console.error('Environment check failed:');
  for (const error of errors) console.error(`- ${error}`);
  console.error('\nNothing was written. Fix the values above and retry.');
  process.exit(1);
}

for (const warning of warnings) console.warn(`Warning: ${warning}`);
console.log('Environment configuration is valid.');
