import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type pg from 'pg';

/**
 * Files in the local attachment storage compared with the attachments in the database (R13,
 * question D5 for the consultant). Read only: nothing is deleted. File names can hold personal
 * data (e.g. the name on an invoice), so the report gives counts per organization folder; the
 * paths are returned only for a separate list the owner asks for.
 */

export type OrphanFolder = {
  /** Folder name: the organization id the files were saved for. */
  folder: string;
  /** Whether that organization exists in the database read. */
  knownOrganization: boolean;
  orphanFiles: number;
  orphanBytes: number;
  oldest: Date | null;
  newest: Date | null;
};

export type OrphanReport = {
  filesOnDisk: number;
  referenced: number;
  /** Attachment rows whose file is missing from the storage. */
  missingFiles: number;
  folders: OrphanFolder[];
  orphanPaths: string[];
};

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

export async function orphanReport(client: pg.Client, storageDir: string): Promise<OrphanReport> {
  // A read-only transaction: the report can never change the database.
  await client.query('BEGIN READ ONLY');
  let paths: Set<string>;
  let organizations: Set<string>;
  try {
    paths = new Set(
      (
        await client.query<{ storage_path: string }>('SELECT storage_path FROM practice_attachment')
      ).rows.map((r) => r.storage_path),
    );
    organizations = new Set(
      (await client.query<{ id: string }>('SELECT id FROM tenant')).rows.map((r) => r.id),
    );
  } finally {
    await client.query('ROLLBACK');
  }

  const files = await filesUnder(storageDir);
  const onDisk = new Set(files);
  const folders = new Map<string, OrphanFolder>();
  const orphanPaths: string[] = [];
  for (const rel of files) {
    if (paths.has(rel)) continue;
    orphanPaths.push(rel);
    const folder = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(radice)';
    const info = await stat(path.join(storageDir, rel));
    const entry = folders.get(folder) ?? {
      folder,
      knownOrganization: organizations.has(folder),
      orphanFiles: 0,
      orphanBytes: 0,
      oldest: null,
      newest: null,
    };
    entry.orphanFiles++;
    entry.orphanBytes += info.size;
    if (!entry.oldest || info.mtime < entry.oldest) entry.oldest = info.mtime;
    if (!entry.newest || info.mtime > entry.newest) entry.newest = info.mtime;
    folders.set(folder, entry);
  }

  return {
    filesOnDisk: files.length,
    referenced: files.length - orphanPaths.length,
    missingFiles: [...paths].filter((p) => !onDisk.has(p)).length,
    folders: [...folders.values()].sort((a, b) => b.orphanFiles - a.orphanFiles),
    orphanPaths: orphanPaths.sort(),
  };
}
