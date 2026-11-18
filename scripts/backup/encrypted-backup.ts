/**
 * Encrypted backup of a database and, optionally, of the attachment storage, without clear text on
 * disk (src/data/backup/encrypted-backup.ts, shared with the nightly backup of the application).
 * The backup is read back through decryption to prove it is complete and usable.
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

import { parseBackupKey, runEncryptedBackup } from '../../src/data/backup/encrypted-backup.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const result = await runEncryptedBackup({
    sourceUrl: required('BACKUP_SOURCE_URL'),
    key: parseBackupKey(required('BACKUP_KEY')),
    backupDir: required('BACKUP_DIR'),
    storageDir: process.env.BACKUP_STORAGE_DIR || null,
    globals: process.env.BACKUP_GLOBALS === 'yes',
  });
  console.log(`Backup verified: ${result.tables} tables, ${result.migrations} migrations`);
  if (result.attachments !== null) console.log(`Attachments: ${result.attachments} files`);
  console.log(`Folder: ${result.dir}`);
}

main().catch((err: unknown) => {
  console.error(`Backup not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
