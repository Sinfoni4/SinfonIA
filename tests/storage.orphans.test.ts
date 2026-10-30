/**
 * Orphan attachment files (R13): files left in the storage by deleted practices are found and
 * counted per organization folder, read only. docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §3.5.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orphanReport } from '../scripts/storage/orphan-files.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('orphan attachment files', () => {
  let prisma: PrismaClient;
  let client: pg.Client;
  let storageDir: string;
  let tenantId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    storageDir = await mkdtemp(path.join(tmpdir(), 'sinfonia-orphans-'));

    tenantId = (
      await new TenantRepository(prisma).createTenant({ name: `orphans-${randomUUID()}` })
    ).id;
    const user = await new UserRepository(prisma).createUser(tenantId, {
      email: `orphans-${randomUUID()}@test.local`,
      role: 'ADMIN',
    });
    const practices = new PracticeApplicationService(prisma, {
      storageService: new LocalStorageService(storageDir),
    });
    const add = async (name: string) => {
      const practice = await practices.createPractice({
        tenantId,
        userId: user.id,
        name,
        kind: 'music',
      });
      await practices.addAttachment({
        tenantId,
        userId: user.id,
        practiceId: practice.id,
        fileName: 'nota.txt',
        mimeType: 'text/plain',
        content: Buffer.from(`fattura ${name}`),
      });
      return practice.id;
    };
    await add('Tenuta');
    const deleted = await add('Cancellata');
    // Today deleting a practice leaves its file in the storage: the orphan to find.
    await practices.deletePractice({ tenantId, practiceId: deleted, userId: user.id });
    // A folder of an organization that is not in this database (e.g. another environment).
    await mkdir(path.join(storageDir, 'altro-ambiente'), { recursive: true });
    await writeFile(path.join(storageDir, 'altro-ambiente', 'file.pdf'), 'x');
  });

  afterAll(async () => {
    await client?.end();
    await prisma?.$disconnect();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('counts the orphan files per organization folder without deleting anything', async () => {
    const before = await readdir(storageDir, { recursive: true });
    const report = await orphanReport(client, storageDir);

    expect(report.filesOnDisk).toBe(3);
    expect(report.referenced).toBe(1);
    const own = report.folders.find((f) => f.folder === tenantId);
    expect(own).toMatchObject({ knownOrganization: true, orphanFiles: 1 });
    expect(own?.orphanBytes).toBe(Buffer.from('fattura Cancellata').length);
    expect(report.folders.find((f) => f.folder === 'altro-ambiente')).toMatchObject({
      knownOrganization: false,
      orphanFiles: 1,
    });
    expect(report.orphanPaths).toHaveLength(2);
    expect(await readdir(storageDir, { recursive: true })).toEqual(before);
  });

  it('reports attachment rows whose file is missing', async () => {
    const report = await orphanReport(client, path.join(storageDir, 'vuota'));
    expect(report.filesOnDisk).toBe(0);
    expect(report.missingFiles).toBeGreaterThanOrEqual(1);
  });
});
