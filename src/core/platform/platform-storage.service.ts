import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

/**
 * Cantiere 1 (console, ELENCO_STEP_MANCANTI §1.3 items 22-23): attachment storage and the last
 * encrypted backup, for the system health page. Counts, sizes and dates only: never file names
 * (they can hold personal data) nor the folders of the server.
 */

/** Where this process keeps attachments and looks for backups (never shown in the console). */
export type HealthLocations = {
  /** The local attachment folder; null with object storage (S3). */
  storageDir: string | null;
  /** BACKUP_DIR; null when not configured on this server. */
  backupDir: string | null;
  /** The database name: backups of other databases in the same folder are ignored. */
  databaseName: string | null;
};

export type StorageHealth = {
  driver: 'local' | 's3';
  attachments: number;
  bytes: number;
  /** The comparison with the files on disk (local storage only, refreshed every 10 minutes). */
  disk: {
    files: number;
    /** Files no attachment refers to (left by a failed upload or a deletion). */
    orphanFiles: number;
    /** Attachments whose file is not on disk. */
    missingFiles: number;
    checkedAt: Date;
  } | null;
};

export type BackupHealth = {
  configured: boolean;
  /** Whether the backup folder can be read now (e.g. the USB disk is connected). */
  reachable: boolean;
  last: { at: Date; tables: number | null; attachments: number | null } | null;
};

const DISK_CHECK_MS = 10 * 60_000;
let diskCache: { key: string; at: number; value: NonNullable<StorageHealth['disk']> } | null = null;

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/'));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function storageHealth(
  prisma: PrismaClient,
  storageDir: string | null,
  now = new Date(),
): Promise<StorageHealth> {
  const totals = await prisma.practiceAttachment.aggregate({
    _count: { _all: true },
    _sum: { fileSize: true },
  });
  const base = {
    attachments: totals._count._all,
    bytes: totals._sum.fileSize ?? 0,
  };
  if (!storageDir) return { driver: 's3', ...base, disk: null };

  if (!diskCache || diskCache.key !== storageDir || now.getTime() - diskCache.at > DISK_CHECK_MS) {
    const [onDisk, rows] = await Promise.all([
      filesUnder(storageDir),
      prisma.practiceAttachment.findMany({ select: { storagePath: true } }),
    ]);
    const files = new Set(onDisk);
    const referenced = new Set(rows.map((r) => r.storagePath.replace(/\\/g, '/')));
    diskCache = {
      key: storageDir,
      at: now.getTime(),
      value: {
        files: files.size,
        orphanFiles: [...files].filter((f) => !referenced.has(f)).length,
        missingFiles: [...referenced].filter((f) => !files.has(f)).length,
        checkedAt: now,
      },
    };
  }
  return { driver: 'local', ...base, disk: diskCache.value };
}

/** Clears the disk comparison kept in memory (tests, or after a cleanup). */
export function resetStorageHealthCache(): void {
  diskCache = null;
}

type Manifest = {
  createdAt?: unknown;
  database?: unknown;
  dump?: { tables?: unknown };
  storage?: { files?: unknown };
};

/**
 * The most recent backup of this database in BACKUP_DIR, read from its manifest (written by
 * `npm run db:backup` only after the dump was verified). The folder is on a USB disk on the
 * current PC: when it is not connected the console says so instead of failing.
 */
export async function backupHealth(
  backupDir: string | null,
  databaseName: string | null,
): Promise<BackupHealth> {
  if (!backupDir) return { configured: false, reachable: false, last: null };
  let folders: string[];
  try {
    folders = (await readdir(backupDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !databaseName || name.startsWith(`${databaseName}_`));
  } catch {
    return { configured: true, reachable: false, last: null };
  }
  let last: BackupHealth['last'] = null;
  for (const folder of folders) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(backupDir, folder, 'manifest.json'), 'utf8'),
      ) as Manifest;
    } catch {
      continue; // No manifest: the backup did not finish.
    }
    if (databaseName && manifest.database !== databaseName) continue;
    const at = typeof manifest.createdAt === 'string' ? new Date(manifest.createdAt) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    if (last && last.at >= at) continue;
    last = {
      at,
      tables: typeof manifest.dump?.tables === 'number' ? manifest.dump.tables : null,
      attachments: typeof manifest.storage?.files === 'number' ? manifest.storage.files : null,
    };
  }
  return { configured: true, reachable: true, last };
}
