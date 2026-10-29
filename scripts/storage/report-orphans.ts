/**
 * Report of the orphan attachment files (files with no attachment row), read only.
 *
 * Env: DATABASE_URL (the database whose attachments are compared), STORAGE_DIR (default
 * STORAGE_LOCAL_DIR, then .runtime/storage, as the application). Optional `--list <file>`: writes the orphan paths to a file outside the
 * repository, for a deletion that needs its own approval. Only the local storage is supported.
 * Usage: npm run storage:orphans
 */
import 'dotenv/config';

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { orphanReport } from './orphan-files.js';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if ((process.env.STORAGE_DRIVER ?? 'local') !== 'local') {
    throw new Error('Only the local storage is supported (STORAGE_DRIVER=local)');
  }
  const storageDir = path.resolve(
    process.env.STORAGE_DIR ?? process.env.STORAGE_LOCAL_DIR ?? '.runtime/storage',
  );
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let report;
  try {
    report = await orphanReport(client, storageDir);
  } finally {
    await client.end();
  }

  console.log(`Database: ${new URL(url).pathname.slice(1)} · Storage: ${storageDir}`);
  console.log(`Files on disk: ${report.filesOnDisk} · referenced: ${report.referenced}`);
  console.log(
    `Orphan files: ${report.orphanPaths.length} · attachment rows without file: ${report.missingFiles}`,
  );
  for (const f of report.folders) {
    console.log(
      `  ${f.folder}${f.knownOrganization ? '' : ' (organization not in this database)'}: ` +
        `${f.orphanFiles} files, ${(f.orphanBytes / 1024).toFixed(0)} KB, ${day(f.oldest)} → ${day(f.newest)}`,
    );
  }

  const listFile = argValue('--list');
  if (listFile) {
    const target = path.resolve(listFile);
    if (target.startsWith(path.resolve('.') + path.sep)) {
      throw new Error('--list must be outside the repository (paths can hold personal data)');
    }
    await writeFile(target, `${report.orphanPaths.join('\n')}\n`, { flag: 'wx' });
    console.log(`Orphan paths written to ${target}`);
  }
}

main().catch((err: unknown) => {
  console.error(`Report not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
