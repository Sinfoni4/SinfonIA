import { execCmd } from '../exec.js';

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeSqlIdentifier(value: string): string {
  return value.replace(/"/g, '""');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function ensureDatabaseExists(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL missing; cannot ensure database exists');
  }

  const url = new URL(databaseUrl);
  const host = url.hostname || '127.0.0.1';
  const port = url.port || '5432';
  const user = url.username;
  const password = url.password;
  const dbName = url.pathname.replace(/^\//, '');

  if (!user || !dbName) {
    throw new Error('DATABASE_URL invalid; missing user or db name');
  }

  const psqlWhich = await execCmd('which psql', 1500);
  if (psqlWhich.code !== 0) {
    throw new Error('psql not available; PostgreSQL client not installed');
  }

  const dbCheckSql = `SELECT 1 FROM pg_database WHERE datname='${escapeSqlStringLiteral(dbName)}';`;
  const checkCmd = `psql -h ${host} -p ${port} -U ${user} -d postgres -tAc ${shellQuote(dbCheckSql)}`;
  const check = await execCmd(checkCmd, 8000, password ? { PGPASSWORD: password } : undefined);
  const exists = check.stdout === '1' || check.stdout.endsWith('1');

  if (!exists) {
    const createSql = `CREATE DATABASE "${escapeSqlIdentifier(dbName)}";`;
    const createCmd = `psql -h ${host} -p ${port} -U ${user} -d postgres -tAc ${shellQuote(createSql)}`;
    const created = await execCmd(
      createCmd,
      10_000,
      password ? { PGPASSWORD: password } : undefined,
    );
    if (created.code !== 0) {
      throw new Error(`Failed to create database ${dbName}: ${created.stderr || created.stdout}`);
    }
  }

  console.log(`🧱 Database ensured: ${dbName}`);
}
