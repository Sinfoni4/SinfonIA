/**
 * Encrypted backup of a database and, optionally, of the attachment storage, without clear text on
 * disk: pg_dump streams into AES-256-GCM (scripts/backup/lib/crypto-stream.ts). The backup is
 * then read back through decryption with `pg_restore --list` to prove it is complete and usable.
 *
 * Env:
 *   BACKUP_SOURCE_URL   database to back up (read only)
 *   BACKUP_KEY          32-byte key, base64 or hex, created and kept by the owner outside the
 *                       repository: without it the backup cannot be restored
 *   BACKUP_DIR          destination folder (outside the repository, ideally another disk)
 *   BACKUP_STORAGE_DIR  optional: attachment folder, encrypted file by file
 *   BACKUP_GLOBALS=yes  optional: roles too (pg_dumpall --globals-only, needs a superuser)
 *   MF0_PG_BIN          optional: folder of the PostgreSQL tools
 * Usage: npm run db:backup
 */
import 'dotenv/config';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

import { decryptFromFile, encryptToFile } from './lib/crypto-stream.js';
import { client, databaseName, spawnTool, tableNames, waitFor } from './lib/pg.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseKey(raw: string): Buffer {
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

async function main() {
  const url = required('BACKUP_SOURCE_URL');
  const key = parseKey(required('BACKUP_KEY'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(required('BACKUP_DIR'), `${databaseName(url)}_${stamp}`);
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
  if (process.env.BACKUP_GLOBALS === 'yes') {
    const file = path.join(dir, 'roles.sql.enc');
    await dumpEncrypted(url, ['--globals-only', '--no-role-passwords'], 'pg_dumpall', file, key);
    globals = { file: path.basename(file), sha256: await sha256(file) };
  }

  let storage: { files: number; bytes: number } | undefined;
  const storageDir = process.env.BACKUP_STORAGE_DIR;
  if (storageDir) {
    storage = { files: 0, bytes: 0 };
    for (const rel of await filesUnder(storageDir)) {
      const target = path.join(dir, 'storage', `${rel}.enc`);
      await mkdir(path.dirname(target), { recursive: true });
      storage.bytes += await encryptToFile(
        createReadStream(path.join(storageDir, rel)),
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
  console.log(`Backup verified: ${tables.length} tables, ${migrations.length} migrations`);
  if (storage) console.log(`Attachments: ${storage.files} files`);
  console.log(`Folder: ${dir}`);
}

main().catch((err: unknown) => {
  console.error(`Backup not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
