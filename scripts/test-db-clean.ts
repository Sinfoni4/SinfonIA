/**
 * Empties the test database (`npm run test:db:clean`): every table but the migrations, so the
 * suite starts again from nothing. The test files leave their data behind (each run adds
 * organizations, practices and messages), and some checks of the whole database slow down as it
 * grows.
 *
 * Only the database of `.env.test`, on this PC, whose name ends in `_test`: never staging (same
 * PostgreSQL cluster) nor anything else. The schema and the migrations stay as they are.
 * `--yes` is required: without it the script only says what it would empty.
 */
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: '.env.test', quiet: true });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function checkTestDatabase(url: string | undefined): { name: string } {
  if (!url) throw new Error('DATABASE_URL is missing in .env.test');
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(u.hostname)) {
    throw new Error(`Only a database on this PC: ${u.hostname} refused`);
  }
  if (!/_test$/.test(name)) throw new Error(`Only a database whose name ends in _test: ${name}`);
  return { name };
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refused with NODE_ENV=production');
  const url = process.env.DATABASE_URL;
  const { name } = checkTestDatabase(url);
  const client = new Client({ connectionString: url, application_name: 'sinfonia-test-clean' });
  await client.connect();
  try {
    const { rows } = await client.query<{ relname: string }>(
      `select relname from pg_class
        where relkind = 'r' and relnamespace = 'public'::regnamespace
          and relname <> '_prisma_migrations'
        order by relname`,
    );
    const tables = rows.map((r) => r.relname);
    const { rows: counts } = await client.query<{ n: string }>(
      'select count(*)::text n from "tenant"',
    );
    console.log(`Database ${name}: ${tables.length} tables, ${counts[0]?.n ?? '?'} organizations.`);
    if (!process.argv.includes('--yes')) {
      console.log('Nothing done. To empty it: npm run test:db:clean -- --yes');
      return;
    }
    await client.query(
      `TRUNCATE ${tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    console.log(`Emptied: ${tables.length} tables (migrations kept).`);
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/test-db-clean.ts')) {
  main().catch((err: unknown) => {
    console.error(`Not done: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
