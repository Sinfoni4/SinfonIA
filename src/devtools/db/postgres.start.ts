import { execSync } from 'node:child_process';

import { execCmd } from '../exec.js';

async function verifyWithPgIsready(): Promise<boolean> {
  const isPgIsready = await execCmd('which pg_isready', 1500);
  if (isPgIsready.code !== 0) return false;

  const res = await execCmd('pg_isready -h 127.0.0.1 -p 5432', 4000);
  return res.code === 0;
}

export async function ensurePostgresRunning(): Promise<void> {
  execSync('systemctl start postgresql || true', { stdio: 'ignore' });
  execSync('pg_ctlcluster --all start || true', { stdio: 'ignore' });

  await new Promise<void>((r) => setTimeout(r, 2000));

  const ok = await verifyWithPgIsready();
  if (ok) {
    console.log('🚀 PostgreSQL started successfully');
    return;
  }

  console.log('❌ PostgreSQL failed to start');
  throw new Error('PostgreSQL failed to start (pg_isready did not succeed)');
}
