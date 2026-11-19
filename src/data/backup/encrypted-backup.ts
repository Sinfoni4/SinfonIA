/**
 * Encrypted backup of a database and, optionally, of the attachment storage, without clear text on
 * disk: pg_dump streams into AES-256-GCM (crypto-stream.ts). The backup is then read back through
 * decryption with `pg_restore` to prove it is complete and usable. Used by `npm run db:backup`
 * and, at night, by the application itself (B4).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

import { decryptFromFile, encryptToFile } from './crypto-stream.js';
import { client, databaseName, spawnTool, tableNames, waitFor } from './pg-tools.js';

export type BackupOptions = {
  /** Database to back up (read only). */
  sourceUrl: string;
  /** 32-byte key: without it the backup cannot be restored. */
  key: Buffer;
  /** Destination folder (outside the repository, ideally another disk). */
  backupDir: string;
  /** Attachment folder, encrypted file by file. */
  storageDir?: string | null;
  /** Roles too (pg_dumpall --globals-only, needs a superuser). */
  globals?: boolean;
};

export type BackupResult = {
  dir: string;
  tables: number;
  migrations: number;
  attachments: number | null;
};

export function parseBackupKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes (base64 or hex)');
  return key;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function dumpEncrypted(url: string, args: string[], tool: string, file: string, key: Buffer) {
  const child = spawnTool(tool, args, url);
  const [bytes] = await Promise.all([
    encryptToFile(child.stdout!, file, key),
    waitFor(child, tool),
  ]);
  return bytes;
}

/**
 * Reads the whole backup back through decryption into `pg_restore --file=-` (clear text only in a
 * pipe): the GCM tag proves the file was not altered, and the COPY sections list the tables.
 */
async function verifyDump(url: string, file: string, key: Buffer): Promise<string[]> {
  const child = spawnTool('pg_restore', ['--file=-'], url);
  const done = waitFor(child, 'pg_restore');
  const tables = new Set<string>();
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    const m = /^COPY public\.("?)([^\s"(]+)\1 /.exec(line);
    if (m) tables.add(m[2]);
  });
  await Promise.all([
    decryptFromFile(file, key).then((clear) => pipeline(clear, child.stdin!)),
    done,
  ]);
  return [...tables];
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

/**
 * Makes one verified backup in a new folder `<database>_<timestamp>` of `backupDir`. The manifest
 * is written last: a folder without it is a backup that did not finish (and is never counted).
 */
export async function runEncryptedBackup(options: BackupOptions): Promise<BackupResult> {
  const { sourceUrl: url, key } = options;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(options.backupDir, `${databaseName(url)}_${stamp}`);
  if (path.resolve(dir).startsWith(path.resolve('.'))) {
    throw new Error('BACKUP_DIR must be outside the repository');
  }
  await mkdir(dir, { recursive: true });

  const dumpFile = path.join(dir, 'database.dump.enc');
  const bytes = await dumpEncrypted(url, ['--format=custom'], 'pg_dump', dumpFile, key);
  const listed = await verifyDump(url, dumpFile, key);

  const c = client(url);
  await c.connect();
  let tables: string[];
  let migrations: string[];
  try {
    tables = await tableNames(c);
    migrations = (
      await c.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1',
      )
    ).rows.map((r) => r.migration_name);
  } finally {
    await c.end();
  }
  const missing = tables.filter((t) => !listed.includes(t));
  if (missing.length > 0) throw new Error(`Tables missing from the backup: ${missing.join(', ')}`);

  let globals: { file: string; sha256: string } | undefined;
  if (options.globals) {
    const file = path.join(dir, 'roles.sql.enc');
    await dumpEncrypted(url, ['--globals-only', '--no-role-passwords'], 'pg_dumpall', file, key);
    globals = { file: path.basename(file), sha256: await sha256(file) };
  }

  let storage: { files: number; bytes: number } | undefined;
  if (options.storageDir) {
    storage = { files: 0, bytes: 0 };
    for (const rel of await filesUnder(options.storageDir)) {
      const target = path.join(dir, 'storage', `${rel}.enc`);
      await mkdir(path.dirname(target), { recursive: true });
      storage.bytes += await encryptToFile(
        createReadStream(path.join(options.storageDir, rel)),
        target,
        key,
      );
      storage.files++;
    }
  }

  // Manifest without data: what the backup holds and how to check that it was not altered.
  const manifest = {
    createdAt: new Date().toISOString(),
    database: databaseName(url),
    encryption: 'AES-256-GCM (12-byte IV, ciphertext, 16-byte tag)',
    dump: {
      file: path.basename(dumpFile),
      clearBytes: bytes,
      encryptedBytes: (await stat(dumpFile)).size,
      sha256: await sha256(dumpFile),
      tables: tables.length,
    },
    migrations,
    ...(globals ? { roles: globals } : {}),
    ...(storage ? { storage } : {}),
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
  });
  return {
    dir,
    tables: tables.length,
    migrations: migrations.length,
    attachments: storage ? storage.files : null,
  };
}

type BackupFolder = { name: string; createdAt: Date; restoreChecked: boolean };

/** The finished backups of one database in `backupDir` (with a manifest), newest first. */
export async function listBackups(backupDir: string, database: string): Promise<BackupFolder[]> {
  const folders: BackupFolder[] = [];
  const entries = await readdir(backupDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(`${database}_`)) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(backupDir, e.name, 'manifest.json'), 'utf8'),
      ) as { createdAt?: unknown; database?: unknown };
      const createdAt = new Date(String(manifest.createdAt));
      if (manifest.database !== database || Number.isNaN(createdAt.getTime())) continue;
      let restoreChecked = false;
      try {
        const check = JSON.parse(
          await readFile(path.join(backupDir, e.name, 'restore-check.json'), 'utf8'),
        ) as { ok?: unknown };
        restoreChecked = check.ok === true;
      } catch {
        // Not checked.
      }
      folders.push({ name: e.name, createdAt, restoreChecked });
    } catch {
      // No manifest: not a finished backup, never touched here.
    }
  }
  return folders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Keeps the `keep` newest finished backups of the database, plus the newest one whose restore was
 * checked; removes the older finished ones. Unfinished folders and other databases' backups are
 * left alone. Returns the folders removed.
 */
export async function rotateBackups(
  backupDir: string,
  database: string,
  keep: number,
): Promise<string[]> {
  if (keep < 1) throw new Error('keep must be at least 1');
  const backups = await listBackups(backupDir, database);
  const checked = backups.find((b) => b.restoreChecked);
  const old = backups.slice(keep).filter((b) => b !== checked);
  for (const b of old) {
    await rm(path.join(backupDir, b.name), { recursive: true, force: true });
  }
  return old.map((b) => b.name);
}
