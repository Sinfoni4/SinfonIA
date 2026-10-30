/**
 * The web dashboard on synthetic data, to look at it in a browser: `npm run web:demo`.
 *
 * - Backend on http://localhost:3200 against the TEST database (.env.test), never staging;
 * - development login: the 6-digit code is shown on screen (no email is sent);
 * - Telegram and WhatsApp off, attachments in .runtime/storage-demo, its own process lock, so it
 *   runs next to staging;
 * - a demo organization with an ADMIN account and some practices, created on the first run.
 *
 * It builds the dashboard first (web/dist). Ctrl+C stops it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.DEMO_PORT ?? 3200);
const EMAIL = 'demo@sinfonia.test';
const STORAGE = path.resolve('.runtime/storage-demo');

function testDatabaseUrl(): string {
  const line = readFileSync('.env.test', 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL missing in .env.test');
  const url = line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
  if (/staging/i.test(url)) throw new Error('The demo never runs on the staging database');
  return url;
}

async function seed(databaseUrl: string): Promise<void> {
  // Loaded here, after DATABASE_URL is known, from the application's own modules.
  const { createPrismaClient } = await import('../../src/data/db/prisma.js');
  const { TenantRepository } = await import('../../src/data/repositories/tenant.repository.js');
  const { UserRepository } = await import('../../src/data/repositories/user.repository.js');
  const { PracticeApplicationService } =
    await import('../../src/core/practice/practice.application.service.js');
  const { LocalStorageService } = await import('../../src/data/storage/storage.service.js');

  const prisma = createPrismaClient(databaseUrl);
  try {
    if (await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true } })) return;
    const tenant = await new TenantRepository(prisma).createTenant({ name: 'Cooperativa Demo' });
    const users = new UserRepository(prisma);
    const admin = await users.createUser(tenant.id, { email: EMAIL, role: 'ADMIN' });
    const member = await users.createUser(tenant.id, {
      email: 'collaboratore.demo@sinfonia.test',
      role: 'MEMBER',
    });
    const practices = new PracticeApplicationService(prisma, {
      storageService: new LocalStorageService(STORAGE),
    });
    const withReceipt = await practices.createPractice({
      tenantId: tenant.id,
      userId: admin.id,
      name: 'Rimborso spese ottobre',
      kind: 'generic',
    });
    await practices.addAttachment({
      tenantId: tenant.id,
      userId: admin.id,
      practiceId: withReceipt.id,
      fileName: 'ricevuta-bar.txt',
      mimeType: 'text/plain',
      content: Buffer.from(
        'RICEVUTA\nBar Centrale\nP.IVA 01122334459\nTotale EUR 12,50\nData 28/10/2026\n',
      ),
    });
    const names = ['Mario Rossi', 'Anna Bianchi', 'Luca Verdi', 'Giulia Neri', 'Paolo Gialli'];
    for (const name of names) {
      await practices.createPractice({
        tenantId: tenant.id,
        userId: member.id,
        name,
        kind: 'music',
      });
    }
    console.log('Dati demo creati (Cooperativa Demo).');
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const databaseUrl = testDatabaseUrl();
  mkdirSync(STORAGE, { recursive: true });

  console.log('Compilazione della dashboard...');
  const build = spawnSync(process.execPath, ['--run', 'web:build'], { stdio: 'inherit' });
  if (build.status !== 0 || !existsSync('web/dist/index.html')) {
    throw new Error('Dashboard build failed (npm run web:build)');
  }

  await seed(databaseUrl);

  const app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(PORT),
      NODE_ENV: 'development',
      SINFONIA_INSTANCE: 'demo',
      AUTH_EMAIL_LOGIN: 'true',
      AUTH_DEV_SHOW_CODE: 'true',
      WEB_DIST_DIR: path.resolve('web/dist'),
      WEB_PUBLIC_URL: `http://localhost:${PORT}`,
      STORAGE_LOCAL_DIR: STORAGE,
      // Never the real bot or WhatsApp number from a demo.
      TELEGRAM_BOT_TOKEN: '',
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_PHONE_NUMBER_ID: '',
      WHATSAPP_APP_SECRET: '',
      WHATSAPP_VERIFY_TOKEN: '',
      ENABLE_LLM: 'false',
    },
  });
  console.log(`\nDashboard demo: http://localhost:${PORT}/app/`);
  console.log(`Accesso con ${EMAIL}: il codice compare sullo schermo. Ctrl+C per fermare.\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.kill(signal));
  }
  app.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}

main().catch((err: unknown) => {
  console.error(`Demo non avviata: ${err instanceof Error ? err.message : 'errore sconosciuto'}`);
  process.exitCode = 1;
});
