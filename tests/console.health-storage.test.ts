/**
 * Console, system health (ELENCO_STEP_MANCANTI §1.3, items 22-23): attachment storage compared
 * with the disk, and the last encrypted backup read from its manifest. Counts and dates only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  backupHealth,
  resetStorageHealthCache,
  storageHealth,
} from '../src/core/platform/platform-storage.service.js';

import type { PrismaClient } from '@prisma/client';

const root = mkdtempSync(path.join(tmpdir(), 'console-health-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(file: string, content = 'x') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Only the two queries the storage check makes. */
function fakePrisma(paths: string[], bytes: number): PrismaClient {
  return {
    practiceAttachment: {
      aggregate: () =>
        Promise.resolve({ _count: { _all: paths.length }, _sum: { fileSize: bytes } }),
      findMany: () => Promise.resolve(paths.map((storagePath) => ({ storagePath }))),
    },
  } as unknown as PrismaClient;
}

describe('attachment storage', () => {
  beforeEach(() => resetStorageHealthCache());

  it('counts orphan and missing files without naming them', async () => {
    const dir = path.join(root, 'storage');
    write(path.join(dir, 'org-a', 'fattura-mario-rossi.pdf'));
    write(path.join(dir, 'org-a', 'avanzo.pdf'));
    const health = await storageHealth(
      fakePrisma(['org-a/fattura-mario-rossi.pdf', 'org-b/sparito.pdf'], 2048),
      dir,
    );
    expect(health).toMatchObject({
      driver: 'local',
      attachments: 2,
      bytes: 2048,
      disk: { files: 2, orphanFiles: 1, missingFiles: 1 },
    });
    expect(JSON.stringify(health)).not.toContain('mario');
  });

  it('reads the disk again only after ten minutes', async () => {
    const dir = path.join(root, 'storage-cache');
    write(path.join(dir, 'a.pdf'));
    const prisma = fakePrisma(['a.pdf'], 1);
    const t0 = new Date('2026-11-05T10:00:00Z');
    expect((await storageHealth(prisma, dir, t0)).disk?.orphanFiles).toBe(0);
    write(path.join(dir, 'b.pdf'));
    const soon = new Date(t0.getTime() + 5 * 60_000);
    expect((await storageHealth(prisma, dir, soon)).disk?.orphanFiles).toBe(0);
    const later = new Date(t0.getTime() + 11 * 60_000);
    expect((await storageHealth(prisma, dir, later)).disk?.orphanFiles).toBe(1);
  });

  it('does not look at a disk with object storage', async () => {
    expect((await storageHealth(fakePrisma([], 0), null)).disk).toBeNull();
  });
});

describe('last encrypted backup', () => {
  const manifest = (database: string, createdAt: string, tables = 26, files = 5) =>
    JSON.stringify({ createdAt, database, dump: { tables }, storage: { files } });

  it('finds the most recent complete backup of this database', async () => {
    const dir = path.join(root, 'backups');
    write(
      path.join(dir, 'sinfonia_staging_old', 'manifest.json'),
      manifest('sinfonia_staging', '2026-11-04T21:53:30Z', 25, 4),
    );
    write(
      path.join(dir, 'sinfonia_staging_new', 'manifest.json'),
      manifest('sinfonia_staging', '2026-11-05T16:46:40Z'),
    );
    // Not finished (no manifest), and another database: both ignored.
    write(path.join(dir, 'sinfonia_staging_broken', 'database.dump.enc'));
    write(
      path.join(dir, 'sinfonia_prod_x', 'manifest.json'),
      manifest('sinfonia_prod', '2026-11-06T00:00:00Z'),
    );
    expect(await backupHealth(dir, 'sinfonia_staging')).toEqual({
      configured: true,
      reachable: true,
      last: { at: new Date('2026-11-05T16:46:40Z'), tables: 26, attachments: 5 },
    });
  });

  it('says when the folder is not configured or not reachable (USB disk missing)', async () => {
    expect(await backupHealth(null, 'sinfonia_staging')).toEqual({
      configured: false,
      reachable: false,
      last: null,
    });
    expect(await backupHealth(path.join(root, 'no-disk'), 'sinfonia_staging')).toEqual({
      configured: true,
      reachable: false,
      last: null,
    });
  });
});
