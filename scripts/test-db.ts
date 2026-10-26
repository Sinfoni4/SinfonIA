import { execSync } from 'node:child_process';

import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: '.env.test' });

const dbUrl = process.env.DATABASE_URL;
const strict = process.argv.includes('--mode=strict') || process.env.AI_TEST_MODE === 'strict';

function log(msg: string): void {
  console.log(`[test-db] ${msg}`);
}

function strictFail(message: string): never {
  const output = [
    '[strict-mode] STRICT MODE FAILED',
    '',
    'Infrastructure issues:',
    `- ${message}`,
    '',
    'Fix steps:',
    '1. Fix Docker access',
    '2. Configure .env.test',
    '3. Restart test',
  ].join('\n');
  console.error(output);
  process.exit(1);
}

async function isDbReachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function run(command: string): void {
  execSync(command, { stdio: 'inherit', env: { ...process.env } });
}

function canRun(command: string): boolean {
  try {
    execSync(command, { stdio: 'ignore', env: { ...process.env } });
    return true;
  } catch {
    return false;
  }
}

function detectComposeCommand(): 'docker compose' | 'docker-compose' | null {
  if (canRun('docker compose version')) return 'docker compose';
  if (canRun('docker-compose version')) return 'docker-compose';
  return null;
}

function diagnoseDocker(): { ok: boolean; reason?: string } {
  if (!canRun('docker --version')) {
    return { ok: false, reason: 'docker_not_found' };
  }

  try {
    execSync('docker info', { stdio: 'ignore', env: { ...process.env } });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('permission denied') || msg.includes('/var/run/docker.sock')) {
      return { ok: false, reason: 'docker_permission_denied' };
    }
    return { ok: false, reason: 'docker_daemon_unavailable' };
  }
}

async function main(): Promise<void> {
  if (!dbUrl) {
    if (strict) strictFail('DATABASE_URL is missing');
    log('DATABASE_URL missing in .env.test; continuing in degraded mode.');
    return;
  }

  let reachable = await isDbReachable(dbUrl);
  if (!reachable) {
    log('DB not reachable. Checking Docker runtime...');
    const docker = diagnoseDocker();
    if (!docker.ok) {
      if (docker.reason === 'docker_not_found') {
        console.error(
          '\nDOCKER NOT FOUND\n\nInstall Docker:\nsudo apt install docker.io docker-compose -y\n',
        );
      } else if (docker.reason === 'docker_permission_denied') {
        console.error(
          '\nDOCKER PERMISSION ERROR\n\nYour user cannot access Docker daemon.\n\nFix:\nsudo usermod -aG docker $USER\nThen logout/login or run:\nnewgrp docker\n',
        );
      } else {
        log('Docker daemon unavailable.');
      }
      if (strict) strictFail('Docker unavailable or permission denied');
      log('Unable to bootstrap Docker. Harness will run interpreter-only mode.');
      return;
    }

    const composeCmd = detectComposeCommand();
    if (!composeCmd) {
      log('No compose command found (docker compose / docker-compose).');
      if (strict) strictFail('Compose command not found');
      return;
    }

    log(`Using compose command: ${composeCmd}`);
    try {
      run(`${composeCmd} -f docker-compose.test.yml up -d`);
    } catch {
      if (strict) strictFail('Unable to start docker-compose.test.yml');
      log('Unable to start docker postgres. Harness will run interpreter-only mode.');
      return;
    }
  }

  // Wait DB readiness
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    log(`Waiting for DB... attempt ${i + 1}/${maxAttempts}`);
    reachable = await isDbReachable(dbUrl);
    if (reachable) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!reachable) {
    if (strict) strictFail('DB not connected after readiness attempts');
    log('DB still unreachable after startup attempts. Continuing in degraded mode.');
    return;
  }

  log('DB reachable. Running migrations...');
  try {
    run('npm run db:migrate:deploy');
    log('Migration completed.');
  } catch {
    if (strict) strictFail('Migration failed');
    log('Migration failed. Continuing; harness may run interpreter-only mode.');
  }
}

void main().catch((err) => {
  log(`Unexpected bootstrap error: ${err instanceof Error ? err.message : String(err)}`);
});
