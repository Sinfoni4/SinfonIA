import { detectPostgresEnvironment } from './postgres.detect.js';

export async function installPostgresIfMissing(): Promise<void> {
  const env = await detectPostgresEnvironment();
  if (env.installed) {
    return;
  }

  console.error('❌ PostgreSQL not installed.');
  console.error('👉 Run: ./scripts/setup-postgres.sh');
  process.exit(1);
}
