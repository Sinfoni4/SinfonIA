/**
 * Cantiere 2 (restore check): takes the most recent backup of a database in BACKUP_DIR, restores
 * it with encrypted-restore.ts into a temporary empty database and folder, checks tables,
 * migrations and attachments against the manifest, and writes the outcome in the backup folder
 * (restore-check.json: counts, dates and the outcome only, never values). The temporary database
 * and folder are always removed. The console shows the last outcome.
 *
 * Meant to run on a schedule (e.g. weekly); scheduling it on the current PC is a change of the
 * system configuration, to be decided by the owner.
 *
 * Env (from .env, as the backup):
 *   BACKUP_DIR, BACKUP_KEY
 *   VERIFY_DATABASE      database whose backups are checked (default sinfonia_staging)
 *   VERIFY_ADMIN_URL     a role that may create and drop databases on the cluster used for the
 *                        check (default: the cluster of .env.test). Never the production cluster.
 * Usage: npm run db:verify-backup
 */
import 'dotenv/config';

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { client } from './lib/pg.js';

type Manifest = {
  createdAt: string;
  database: string;
  dump: { tables: number };
  migrations?: string[];
  storage?: { files: number };
};

export type RestoreCheck = {
  checkedAt: string;
  ok: boolean;
  backupCreatedAt: string;
  tables: number | null;
  migrations: number | null;
  files: number | null;
  seconds: number;
  /** A short reason when it failed (no values of the backup). */
  problem?: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function adminUrl(): string {
  if (process.env.VERIFY_ADMIN_URL) return process.env.VERIFY_ADMIN_URL;
  const line = readFileSync('.env.test', 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('VERIFY_ADMIN_URL is required (no .env.test)');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

async function latestBackup(dir: string, database: string) {
  let best: { folder: string; manifest: Manifest } | null = null;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${database}_`)) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(dir, entry.name, 'manifest.json'), 'utf8'),
      ) as Manifest;
      if (manifest.database !== database) continue;
      if (!best || manifest.createdAt > best.manifest.createdAt) {
        best = { folder: path.join(dir, entry.name), manifest };
      }
    } catch {
      // No manifest: the backup did not finish.
    }
  }
  return best;
}

function runRestore(env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve('scripts/backup/encrypted-restore.ts')],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main() {
  const started = Date.now();
  const dir = path.resolve(required('BACKUP_DIR'));
  required('BACKUP_KEY');
  const database = process.env.VERIFY_DATABASE ?? 'sinfonia_staging';
  const backup = await latestBackup(dir, database);
  if (!backup) throw new Error(`No complete backup of ${database} in BACKUP_DIR`);

  const admin = adminUrl();
  const tempName = `restore_check_${randomBytes(4).toString('hex')}`;
  const target = new URL(admin);
  target.pathname = `/${tempName}`;
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'sinfonia-restore-check-'));

  const result: RestoreCheck = {
    checkedAt: new Date().toISOString(),
    ok: false,
    backupCreatedAt: backup.manifest.createdAt,
    tables: null,
    migrations: null,
    files: null,
    seconds: 0,
  };
  const adminClient = client(admin);
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${tempName}"`);
    const restore = await runRestore({
      RESTORE_FROM: backup.folder,
      RESTORE_TARGET_URL: target.toString(),
      RESTORE_STORAGE_DIR: storageDir,
    });
    if (restore.code !== 0) {
      // Only the restore script's own message, which never holds values of the backup.
      result.problem = /Restore not done: ([^\n]*)/.exec(restore.output)?.[1] ?? 'restore failed';
    } else {
      const check = client(target.toString());
      await check.connect();
      try {
        result.tables = (
          await check.query<{ n: number }>(
            `SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`,
          )
        ).rows[0]!.n;
        result.migrations = (
          await check.query<{ n: number }>(
            `SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
          )
        ).rows[0]!.n;
      } finally {
        await check.end();
      }
      result.files = (await readdir(storageDir, { recursive: true, withFileTypes: true })).filter(
        (e) => e.isFile(),
      ).length;
      const expected = {
        tables: backup.manifest.dump.tables,
        migrations: backup.manifest.migrations?.length ?? result.migrations,
        files: backup.manifest.storage?.files ?? result.files,
      };
      const wrong = (['tables', 'migrations', 'files'] as const).filter(
        (k) => result[k] !== expected[k],
      );
      result.ok = wrong.length === 0;
      if (!result.ok) result.problem = `different from the manifest: ${wrong.join(', ')}`;
    }
  } finally {
    await adminClient.query(`DROP DATABASE IF EXISTS "${tempName}" WITH (FORCE)`).catch(() => {});
    await adminClient.end();
    await rm(storageDir, { recursive: true, force: true });
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  await writeFile(path.join(backup.folder, 'restore-check.json'), JSON.stringify(result, null, 2));
  console.log(
    result.ok
      ? `Restore check OK: ${result.tables} tables, ${result.migrations} migrations, ${result.files} files (${result.seconds} s)`
      : `Restore check FAILED: ${result.problem}`,
  );
  console.log(`Backup of ${backup.manifest.createdAt}; outcome written in its folder.`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`Restore check not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 2;
});
