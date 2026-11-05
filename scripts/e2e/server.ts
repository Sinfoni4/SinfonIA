/**
 * The server of the end-to-end tests of the dashboard (FE5): started by Playwright
 * (web/playwright.config.ts), stopped at the end of the run.
 *
 * - Backend on http://127.0.0.1:3300 against the TEST database (.env.test, or DATABASE_URL when
 *   set, as in CI), never staging;
 * - development login: the 6-digit code is shown on screen (no email is sent);
 * - Telegram, WhatsApp and the AI off; attachments in .runtime/storage-e2e; its own process lock;
 * - an organization with an administrator and a consultant in another organization, created on
 *   the first run; tests add their own practices with unique names;
 * - the login codes of the test accounts of earlier runs are removed at start, because an email
 *   gets at most 5 codes per hour; the tests log in once per device and share the page.
 *
 * Usage: npm run web:e2e (runs the tests), or node --import tsx scripts/e2e/server.ts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.E2E_PORT ?? 3300);
export const E2E_ADMIN = 'e2e.admin@sinfonia.test';
export const E2E_CONSULTANT = 'e2e.consulente@sinfonia.test';
const E2E_OPERATOR = 'e2e.operatore@sinfonia.test';
const STORAGE = path.resolve('.runtime/storage-e2e');

function databaseUrl(): string {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const line = readFileSync('.env.test', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('DATABASE_URL='));
    if (!line) throw new Error('DATABASE_URL missing in .env.test');
    url = line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
  }
  if (/staging/i.test(url)) throw new Error('The end-to-end tests never run on staging');
  return url;
}

async function seed(url: string): Promise<void> {
  const { createPrismaClient } = await import('../../src/data/db/prisma.js');
  const { TenantRepository } = await import('../../src/data/repositories/tenant.repository.js');
  const { UserRepository } = await import('../../src/data/repositories/user.repository.js');
  const prisma = createPrismaClient(url);
  try {
    // Login codes are limited to 5 per email per hour (a security rule, kept as it is): a new
    // run starts without the codes of the previous runs, for the test accounts only.
    await prisma.authChallenge.deleteMany({
      where: { email: { in: [E2E_ADMIN, E2E_CONSULTANT, E2E_OPERATOR] } },
    });
    if (await prisma.user.findFirst({ where: { email: E2E_ADMIN }, select: { id: true } })) return;
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    const company = await tenants.createTenant({ name: 'Azienda E2E' });
    await users.createUser(company.id, { email: E2E_ADMIN, role: 'ADMIN' });
    await users.createUser(company.id, { email: E2E_OPERATOR, role: 'OPERATOR' });
    const studio = await tenants.createTenant({ name: 'Studio E2E' });
    await users.createUser(studio.id, { email: E2E_CONSULTANT, role: 'ADMIN' });
    console.log('Dati dei test end-to-end creati (Azienda E2E, Studio E2E).');
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const url = databaseUrl();
  mkdirSync(STORAGE, { recursive: true });
  if (process.env.E2E_SKIP_BUILD !== 'true') {
    const build = spawnSync(process.execPath, ['--run', 'web:build'], { stdio: 'inherit' });
    if (build.status !== 0 || !existsSync('web/dist/index.html')) {
      throw new Error('Dashboard build failed (npm run web:build)');
    }
  }
  await seed(url);
  const app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: String(PORT),
      NODE_ENV: 'development',
      SINFONIA_INSTANCE: 'e2e',
      AUTH_EMAIL_LOGIN: 'true',
      AUTH_DEV_SHOW_CODE: 'true',
      WEB_DIST_DIR: path.resolve('web/dist'),
      WEB_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      STORAGE_LOCAL_DIR: STORAGE,
      // Generous limits: a test run logs in many times from the same address.
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      TELEGRAM_BOT_TOKEN: '',
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_PHONE_NUMBER_ID: '',
      WHATSAPP_APP_SECRET: '',
      WHATSAPP_VERIFY_TOKEN: '',
      ENABLE_LLM: 'false',
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.kill(signal));
  }
  app.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}

main().catch((err: unknown) => {
  console.error(`E2E server not started: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
