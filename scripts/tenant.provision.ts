import 'dotenv/config';

import { loadConfig } from '../src/config/config.js';
import { provisionTenant } from '../src/core/tenant/tenant.provisioning.js';
import { createPrismaClient } from '../src/data/db/prisma.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

const name = readArg('name')?.trim();
if (!name) {
  console.error(
    'Usage: npm run tenant:provision -- --name "Cooperativa" [--module music] [--integration none|external] [--scheduler] [--frequency daily|weekly|monthly] [--admin-email admin@example.com] [--admin-telegram-id 123456789]',
  );
  process.exit(1);
}

const adminTelegramId = readArg('admin-telegram-id')?.trim();
if (adminTelegramId && !/^\d{1,20}$/.test(adminTelegramId)) {
  console.error('--admin-telegram-id must contain 1-20 digits.');
  process.exit(1);
}

const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);

try {
  const result = await provisionTenant(prisma, {
    name,
    module: readArg('module') ?? 'music',
    integration: {
      type: readArg('integration') === 'external' ? 'external' : 'none',
    },
    scheduler: {
      enabled: process.argv.includes('--scheduler'),
      frequency:
        readArg('frequency') === 'daily'
          ? 'daily'
          : readArg('frequency') === 'weekly'
            ? 'weekly'
            : 'monthly',
    },
    adminEmail: readArg('admin-email'),
    adminTelegramId,
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
