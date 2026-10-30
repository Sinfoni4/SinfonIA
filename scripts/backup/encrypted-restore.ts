/**
 * Restores a backup made by encrypted-backup.ts into an EMPTY database (and, optionally, an empty
 * attachment folder). The file is checked against the manifest first; decryption streams into
 * pg_restore, so the clear text never touches the disk, and an altered file stops the restore.
 *
 * Env:
 *   RESTORE_FROM          backup folder (with manifest.json)
 *   BACKUP_KEY            the key used for the backup (base64 or hex)
 *   RESTORE_TARGET_URL    empty database to restore into
 *   RESTORE_STORAGE_DIR   optional: empty folder for the attachments
 *   MF0_PG_BIN            optional: folder of the PostgreSQL tools
 * Usage: npm run db:restore
 */
import 'dotenv/config';

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { decryptFromFile } from './lib/crypto-stream.js';
import { client, spawnTool, tableNames, waitFor } from './lib/pg.js';

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

type Manifest = { dump: { file: string; sha256: string; tables: number } };

async function main() {
  const from = path.resolve(required('RESTORE_FROM'));
  const key = parseKey(required('BACKUP_KEY'));
  const target = required('RESTORE_TARGET_URL');
  const manifest = JSON.parse(await readFile(path.join(from, 'manifest.json'), 'utf8')) as Manifest;
  const dumpFile = path.join(from, manifest.dump.file);
  if ((await sha256(dumpFile)) !== manifest.dump.sha256) {
    throw new Error('The backup file does not match its manifest');
  }

  const c = client(target);
  await c.connect();
  try {
    if ((await tableNames(c)).length > 0) throw new Error('The target database is not empty');
  } finally {
    await c.end();
  }

  // --dbname is taken from the connection environment of spawnTool (never on the command line).
  const restore = spawnTool(
    'pg_restore',
    ['--exit-on-error', '--single-transaction', `--dbname=${new URL(target).pathname.slice(1)}`],
    target,
  );
  // Both awaited together: a wrong key or an altered file fails the stream and pg_restore.
  await Promise.all([
    decryptFromFile(dumpFile, key).then((clear) => pipeline(clear, restore.stdin!)),
    waitFor(restore, 'pg_restore'),
  ]);

  const check = client(target);
  await check.connect();
  let tables: number;
  try {
    tables = (await tableNames(check)).length;
  } finally {
    await check.end();
  }
  if (tables !== manifest.dump.tables) {
    throw new Error(`Restored ${tables} tables, the backup has ${manifest.dump.tables}`);
  }

  const storageTarget = process.env.RESTORE_STORAGE_DIR;
  const storageFrom = path.join(from, 'storage');
  let files = 0;
  if (storageTarget) {
    await mkdir(storageTarget, { recursive: true });
    if ((await readdir(storageTarget)).length > 0) {
      throw new Error('RESTORE_STORAGE_DIR is not empty');
    }
    const entries = await readdir(storageFrom, { withFileTypes: true, recursive: true });
    for (const e of entries.filter((x) => x.isFile() && x.name.endsWith('.enc'))) {
      const rel = path.relative(storageFrom, path.join(e.parentPath, e.name)).slice(0, -4);
      const out = path.join(storageTarget, rel);
      await mkdir(path.dirname(out), { recursive: true });
      await pipeline(
        await decryptFromFile(path.join(e.parentPath, e.name), key),
        createWriteStream(out, { flags: 'wx' }),
      );
      files++;
    }
  }
  console.log(`Restore verified: ${tables} tables${storageTarget ? `, ${files} files` : ''}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'unknown error';
  // pg_restore stops reading when the decrypted stream is not a valid archive.
  const hint = /EPIPE|unable to authenticate/i.test(message) ? ' (wrong key or damaged file)' : '';
  console.error(`Restore not done: ${message}${hint}`);
  process.exitCode = 1;
});
