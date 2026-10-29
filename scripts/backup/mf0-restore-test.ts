/**
 * MF0 — backup and restore test (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §10).
 *
 * 1. Reads the source in one read-only snapshot: catalog and a fingerprint of every row.
 * 2. Dumps the same snapshot with pg_dump, encrypted on the fly (the dump never exists in clear).
 * 3. Restores it on the fly into an empty target database: decrypt → pg_restore → substitution
 *    of every personal value → psql. The rows of the dump are fingerprinted before substitution.
 * 4. Verifies V1-V10 and writes a report with counts, matches and timings only (no values).
 *
 * Phase 1 (authorized): synthetic source only. The script refuses a staging source unless
 * MF0_PHASE=2 and MF0_STAGING_APPROVED=yes are set for an approved phase-2 run.
 *
 * Env: MF0_SOURCE_URL, MF0_TARGET_URL, MF0_WORK_DIR, optional MF0_PG_BIN.
 * Usage: npx tsx scripts/backup/mf0-restore-test.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { PracticeApplicationService } from '../../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../../src/data/db/prisma.js';

import { decryptFromFile, encryptToFile } from './lib/crypto-stream.js';
import { RowDigests, ValueSet } from './lib/digests.js';
import { splitCopyLine } from './lib/copy-text.js';
import {
  catalog,
  client,
  databaseName,
  orphanRows,
  spawnTool,
  tableColumns,
  tableNames,
  waitFor,
  writeCounters,
} from './lib/pg.js';
import { createRestoreTransform } from './lib/restore-stream.js';
import { Substitution } from './lib/substitution.js';

type Check = { ok: boolean; detail?: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Streams every table of a database (optionally inside an exported snapshot) row by row. */
async function copyTables(
  url: string,
  snapshot: string | null,
  tables: string[],
  onLine: (table: string, line: string) => void,
): Promise<void> {
  const marker = `__MF0_${randomBytes(8).toString('hex')}__`;
  const script = [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
    ...(snapshot ? [`SET TRANSACTION SNAPSHOT '${snapshot}';`] : []),
    ...tables.flatMap((t) => [`\\echo ${marker} ${t}`, `COPY public."${t}" TO STDOUT;`]),
    'COMMIT;',
    '',
  ].join('\n');
  const psql = spawnTool('psql', ['-q', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'], url);
  let current = '';
  let pending = '';
  psql.stdout!.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      // psql on Windows ends lines with CRLF; a raw CR is never part of COPY data.
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith(`${marker} `)) current = line.slice(marker.length + 1);
      else if (current) onLine(current, line);
    }
  });
  psql.stdin!.end(script);
  await waitFor(psql, 'psql (copy)');
}

/** V8: file backup mechanism on synthetic files only (real attachments are excluded). */
async function syntheticAttachments(
  workDir: string,
  key: Buffer,
): Promise<Check & { files: number }> {
  const src = path.join(workDir, 'synthetic-storage');
  const backup = path.join(workDir, 'synthetic-storage-backup');
  const restored = path.join(workDir, 'synthetic-storage-restored');
  const files: string[] = [];
  for (const tenant of ['tenant-a', 'tenant-b']) {
    await mkdir(path.join(src, tenant, 'attachments'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      const rel = path.join(tenant, 'attachments', `sintetico-${i}.bin`);
      await writeFile(path.join(src, rel), randomBytes(2048 + i * 1024));
      files.push(rel);
    }
  }
  await mkdir(backup, { recursive: true });
  for (const rel of files) {
    await encryptToFile(
      createReadStream(path.join(src, rel)),
      path.join(backup, `${createHash('sha256').update(rel).digest('hex')}.enc`),
      key,
    );
  }
  let mismatches = 0;
  for (const rel of files) {
    const out = path.join(restored, rel);
    await mkdir(path.dirname(out), { recursive: true });
    const enc = path.join(backup, `${createHash('sha256').update(rel).digest('hex')}.enc`);
    await pipeline(await decryptFromFile(enc, key), createWriteStream(out));
    if ((await sha256File(out)) !== (await sha256File(path.join(src, rel)))) mismatches++;
  }
  return { ok: mismatches === 0, files: files.length, detail: `${mismatches} mismatches` };
}

function listTemp(): Set<string> {
  return new Set(readdirSync(os.tmpdir()).filter((n) => n !== 'claude'));
}

async function main() {
  const sourceUrl = required('MF0_SOURCE_URL');
  const targetUrl = required('MF0_TARGET_URL');
  const workDir = path.resolve(required('MF0_WORK_DIR'));
  const phase = process.env.MF0_PHASE ?? '1';
  if (
    /staging/i.test(databaseName(sourceUrl)) &&
    !(phase === '2' && process.env.MF0_STAGING_APPROVED === 'yes')
  ) {
    throw new Error('Staging source refused: phase 1 runs on synthetic data only');
  }
  if (sourceUrl === targetUrl) throw new Error('Source and target must differ');
  await mkdir(workDir, { recursive: true });
  const toolTmp = path.join(workDir, 'tool-tmp');
  await mkdir(toolTmp, { recursive: true });
  process.env.MF0_TOOL_TMP = toolTmp;

  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - start;
    }
  };
  const tempBefore = listTemp();
  const cipherKey = randomBytes(32);
  const hmacKey = randomBytes(32);

  // 1. Source snapshot: catalog and row fingerprints.
  const source = client(sourceUrl);
  await source.connect();
  const countersBefore = await writeCounters(source);
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await source.query<{ s: string }>('select pg_export_snapshot() s')).rows[0]!.s;
  const columns = await tableColumns(source);
  const tables = await tableNames(source);
  const sourceCatalog = await catalog(source);
  const sourceDigests = new RowDigests(hmacKey);
  tables.forEach((t) => sourceDigests.touch(t));
  await time('source_fingerprints', () =>
    copyTables(sourceUrl, snapshot, tables, (t, l) => sourceDigests.add(t, l)),
  );

  // 2. Encrypted dump of the same snapshot.
  const dumpPath = path.join(workDir, 'backup.dump.enc');
  const dumpBytes = await time('dump', async () => {
    const dump = spawnTool('pg_dump', ['--format=custom', `--snapshot=${snapshot}`], sourceUrl);
    const [bytes] = await Promise.all([
      encryptToFile(dump.stdout!, dumpPath, cipherKey),
      waitFor(dump, 'pg_dump'),
    ]);
    return bytes;
  });
  await source.query('COMMIT');

  // 3. Restore with substitution.
  const target = client(targetUrl);
  await target.connect();
  if ((await tableNames(target)).length > 0) throw new Error('Target database is not empty');
  const substitution = new Substitution();
  const dumpDigests = new RowDigests(hmacKey);
  const originals = new ValueSet(hmacKey);
  const unchangedByRule = new Map<string, number>();
  await time('restore', async () => {
    const plain = await decryptFromFile(dumpPath, cipherKey);
    const restore = spawnTool(
      'pg_restore',
      ['--no-owner', '--no-privileges', '-f', '-'],
      targetUrl,
    );
    const psql = spawnTool('psql', ['-q', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'], targetUrl);
    psql.stdout!.resume();
    await Promise.all([
      pipeline(plain, restore.stdin!),
      pipeline(
        restore.stdout!,
        createRestoreTransform({ columns, substitution, dumpDigests, originals, unchangedByRule }),
        psql.stdin!,
      ),
      waitFor(restore, 'pg_restore'),
      waitFor(psql, 'psql (restore)'),
    ]);
  });

  // 4. Verification.
  const checks: Record<string, Check> = {};
  const src = sourceDigests.result();
  const dmp = dumpDigests.result();
  const tableReport = tables.map((t) => ({
    table: t,
    rows: src.get(t)?.rows ?? 0,
    dumpMatchesSource:
      src.get(t)?.digest === dmp.get(t)?.digest && src.get(t)?.rows === dmp.get(t)?.rows,
  }));
  checks.V1_rows = { ok: tableReport.every((t) => t.dumpMatchesSource) };

  const targetCounts = new Map<string, number>();
  for (const t of tables) {
    const { rows } = await target.query<{ n: number }>(`select count(*)::int n from public."${t}"`);
    targetCounts.set(t, rows[0]?.n ?? -1);
  }
  checks.V2_counts = { ok: tables.every((t) => targetCounts.get(t) === (src.get(t)?.rows ?? 0)) };

  const targetCatalog = await catalog(target);
  const kinds = [...new Set([...sourceCatalog.keys(), ...targetCatalog.keys()])];
  const catalogReport = kinds.map((k) => ({
    kind: k,
    source: sourceCatalog.get(k)?.length ?? 0,
    target: targetCatalog.get(k)?.length ?? 0,
    match:
      JSON.stringify(sourceCatalog.get(k) ?? []) === JSON.stringify(targetCatalog.get(k) ?? []),
  }));
  checks.V3_schema = { ok: catalogReport.every((c) => c.match) };

  const orphans = await orphanRows(target);
  checks.V4_relations = { ok: orphans === 0, detail: `${orphans} orphan rows` };

  const auditRows = targetCounts.get('audit_log') ?? 0;
  if (auditRows > 0) {
    await target.query('BEGIN');
    let rejected = false;
    try {
      await target.query(
        'update audit_log set event_type = event_type where id = (select id from audit_log limit 1)',
      );
    } catch {
      rejected = true;
    }
    await target.query('ROLLBACK');
    checks.V5_audit_trigger = { ok: rejected };
  } else {
    checks.V5_audit_trigger = { ok: false, detail: 'no audit rows to test' };
  }

  const keptTables = tables.filter((t) =>
    (columns.get(t) ?? []).every((c) => substitution.keeps(t, c)),
  );
  const changedTables = tables.filter((t) => !keptTables.includes(t));
  const targetDigests = new RowDigests(hmacKey);
  let leaks = 0;
  await copyTables(targetUrl, null, tables, (table, line) => {
    if (keptTables.includes(table)) {
      targetDigests.add(table, line);
      return;
    }
    const cols = columns.get(table) ?? [];
    splitCopyLine(line).forEach((value, i) => {
      const col = cols[i];
      if (value !== null && col && !substitution.keeps(table, col) && originals.has(value)) leaks++;
    });
  });
  const tgt = targetDigests.result();
  checks.V6_unchanged_tables = {
    ok: keptTables.every(
      (t) =>
        (tgt.get(t)?.rows ?? 0) === (src.get(t)?.rows ?? 0) &&
        ((src.get(t)?.rows ?? 0) === 0 || tgt.get(t)?.digest === src.get(t)?.digest),
    ),
    detail: keptTables.join(', '),
  };
  // A check that saw no values proves nothing: it fails when rows to substitute existed.
  const rowsToSubstitute = changedTables.reduce((n, t) => n + (src.get(t)?.rows ?? 0), 0);
  checks.anonymization = {
    ok:
      leaks === 0 &&
      substitution.unclassified.size === 0 &&
      (rowsToSubstitute === 0 || originals.size > 0),
    detail:
      `${originals.size} substituted values, ${leaks} found in the copy, ${substitution.unclassified.size} unclassified columns; ` +
      `left identical by the rules: ${[...unchangedByRule].map(([c, n]) => `${c} (${n})`).join(', ') || 'none'}`,
  };

  const prisma = createPrismaClient(targetUrl);
  let read = 0;
  let unreadable = 0;
  try {
    const service = new PracticeApplicationService(prisma);
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      const practices = await service.listPractices({ tenantId: t.id });
      read += practices.length;
      unreadable += practices.filter((p) => !p.name).length;
    }
  } finally {
    await prisma.$disconnect();
  }
  checks.V7_app_read = {
    ok: read === (targetCounts.get('practice') ?? 0) && unreadable === 0,
    detail: `${read} practices read, ${unreadable} without a name`,
  };

  const attachments = await time('synthetic_attachments', () =>
    syntheticAttachments(workDir, cipherKey),
  );
  checks.V8_synthetic_attachments = {
    ok: attachments.ok,
    detail: `${attachments.files} files, ${attachments.detail}`,
  };

  const countersAfter = await writeCounters(source);
  const changedSource = [...countersAfter].filter(([t, n]) => n !== (countersBefore.get(t) ?? 0));
  checks.V9_source_unchanged = {
    ok: changedSource.length === 0,
    detail:
      changedSource
        .map(([t, n]) => `${t}: +${n - (countersBefore.get(t) ?? 0)} writes`)
        .join(', ') || 'no writes',
  };

  const tempAfter = listTemp();
  const newTemp = [...tempAfter].filter((n) => !tempBefore.has(n));
  const artifacts = await readdir(workDir, { recursive: true });
  const toolTempFiles = await readdir(toolTmp);
  checks.V10_disk = {
    ok: toolTempFiles.length === 0,
    detail:
      `${toolTempFiles.length} temporary files written by the PostgreSQL tools; ` +
      `${newTemp.length} new entries in the system temp folder from other processes (not attributable to the test); ` +
      `artifacts in the work folder: ${artifacts.length}`,
  };

  await source.end();
  await target.end();
  cipherKey.fill(0);
  hmacKey.fill(0);

  const report = {
    phase,
    finishedAt: new Date().toISOString(),
    shiftDays: Math.sign(substitution.shiftDays),
    dumpBytesClear: dumpBytes,
    dumpBytesEncrypted: statSync(dumpPath).size,
    timingsMs: timings,
    tables: tableReport.map((t) => ({
      ...t,
      targetRows: targetCounts.get(t.table),
      substituted: changedTables.includes(t.table),
    })),
    catalog: catalogReport,
    checks,
    passed: Object.values(checks).every((c) => c.ok),
  };
  await writeFile(path.join(workDir, 'mf0-report.json'), JSON.stringify(report, null, 2));
  // Summary only: names of checks and their outcome.
  for (const [name, c] of Object.entries(checks)) {
    console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(
    `tables: ${tables.length}, rows: ${[...src.values()].reduce((a, b) => a + b.rows, 0)}, timings: ${JSON.stringify(timings)}`,
  );
  console.log(report.passed ? 'MF0 PASSED' : 'MF0 FAILED');
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`MF0 aborted: ${err instanceof Error ? err.message : 'unknown error'}`);
  // Exit even if a connection is still open: an aborted run must not hang.
  process.exit(2);
});
