/**
 * B4: the nightly backup made by the application. It runs once a day after the chosen time, not
 * again when a backup of today already exists, retries a failure after an hour (three times a day
 * at most), and keeps only the newest backups (plus the newest one checked with a restore).
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import {
  isBackupTime,
  NightlyBackup,
  nightlyBackupStatus,
  registerNightlyBackup,
  scheduledAt,
} from '../src/core/platform/nightly-backup.js';
import {
  listBackups,
  parseBackupKey,
  rotateBackups,
  type BackupOptions,
} from '../src/data/backup/encrypted-backup.js';

const DB = 'sinfonia_b4';

async function fakeBackup(
  dir: string,
  createdAt: Date,
  opts: { checked?: boolean; db?: string } = {},
) {
  const name = `${opts.db ?? DB}_${createdAt.toISOString().replace(/[:.]/g, '-')}`;
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, 'manifest.json'),
    JSON.stringify({ createdAt: createdAt.toISOString(), database: opts.db ?? DB }),
  );
  if (opts.checked) {
    await writeFile(path.join(dir, name, 'restore-check.json'), JSON.stringify({ ok: true }));
  }
  return name;
}

describe('backup rotation', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sinfonia-b4-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the newest backups and the newest one checked, never other folders', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 2));
    const checked = await fakeBackup(dir, day(1), { checked: true });
    await fakeBackup(dir, day(2));
    await fakeBackup(dir, day(3));
    const keep = [await fakeBackup(dir, day(4)), await fakeBackup(dir, day(5))];
    const otherDb = await fakeBackup(dir, day(1), { db: 'altro' });
    await mkdir(path.join(dir, `${DB}_unfinished`)); // no manifest: a backup that did not finish

    const removed = await rotateBackups(dir, DB, 2);
    expect(removed).toHaveLength(2);
    expect((await readdir(dir)).sort()).toEqual(
      [checked, ...keep, otherDb, `${DB}_unfinished`].sort(),
    );
    expect((await listBackups(dir, DB)).map((b) => b.name)).toEqual(
      [...keep].reverse().concat(checked),
    );
  });
});

describe('the nightly backup', () => {
  let dir = '';
  let now = new Date();
  const log = { info: vi.fn(), error: vi.fn() };
  const make = (run: (o: BackupOptions) => Promise<unknown>) =>
    new NightlyBackup({
      at: '02:30',
      keep: 3,
      database: DB,
      backup: { sourceUrl: 'postgres://x/sinfonia_b4', key: Buffer.alloc(32), backupDir: dir },
      log,
      run: async (o) => {
        await run(o);
        await fakeBackup(dir, now);
        return { dir, tables: 10, migrations: 5, attachments: 2 };
      },
      now: () => now,
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sinfonia-b4-'));
    log.info.mockReset();
    log.error.mockReset();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs once after the chosen time and rotates', async () => {
    for (let n = 1; n <= 4; n++) await fakeBackup(dir, new Date(2026, 10, n, 2, 30));
    const run = vi.fn(() => Promise.resolve());
    const nightly = make(run);
    now = new Date(2026, 10, 18, 2, 0);
    expect(await nightly.tick()).toEqual({ skipped: 1 });
    now = new Date(2026, 10, 18, 2, 35);
    expect(await nightly.tick()).toEqual({ backups: 1, removed: 2 });
    now = new Date(2026, 10, 18, 9, 0);
    expect(await nightly.tick()).toEqual({ skipped: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(nightly.status()).toEqual({
      at: '02:30',
      keep: 3,
      lastRun: { at: new Date(2026, 10, 18, 2, 35), ok: true },
    });
    expect((await listBackups(dir, DB)).length).toBe(3);
  });

  it('does not run again when a backup of today was already made (e.g. before a restart)', async () => {
    await fakeBackup(dir, new Date(2026, 10, 18, 3, 0));
    const run = vi.fn(() => Promise.resolve());
    now = new Date(2026, 10, 18, 4, 0);
    expect(await make(run).tick()).toEqual({ skipped: 1 });
    expect(run).not.toHaveBeenCalled();
  });

  it('retries a failure after an hour, three times a day at most', async () => {
    const run = vi.fn(() => Promise.reject(new Error('pg_dump exited with 1')));
    const nightly = registerNightlyBackup(make(run));
    const at = (h: number, m = 0) => {
      now = new Date(2026, 10, 18, h, m);
      return nightly.tick();
    };
    expect(await at(2, 30)).toEqual({ failed: 1 });
    expect(nightlyBackupStatus()?.lastRun).toEqual({ at: now, ok: false });
    expect(await at(3, 0)).toEqual({ skipped: 1 });
    expect(await at(3, 31)).toEqual({ failed: 1 });
    expect(await at(4, 35)).toEqual({ failed: 1 });
    expect(await at(6, 0)).toEqual({ skipped: 1 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(expect.any(Object), 'Nightly backup failed');
    // The next night it tries again.
    expect(await at(26, 31)).toEqual({ failed: 1 });
  });

  it('reports a folder that cannot be reached (USB disk not connected)', async () => {
    await rm(dir, { recursive: true, force: true });
    const run = vi.fn(() => Promise.resolve());
    now = new Date(2026, 10, 18, 3, 0);
    expect(await make(run).tick()).toEqual({ failed: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.any(Object),
      'Nightly backup folder not reachable',
    );
  });
});

describe('nightly backup settings', () => {
  const base = {
    NODE_ENV: 'test',
    PORT: '3017',
    DATABASE_URL: 'postgres://u:p@localhost:5433/db',
    SERVICE_NAME: 'sinfonia-b4',
    AUTH_SECRET: 'x'.repeat(48),
  };

  it('checks the time and needs the folder and the key', () => {
    expect(isBackupTime('02:30')).toBe(true);
    expect(isBackupTime('24:00')).toBe(false);
    expect(scheduledAt('02:30', new Date(2026, 10, 18, 12)).getHours()).toBe(2);
    expect(() => loadConfig({ ...base, BACKUP_NIGHTLY_AT: '2:30' })).toThrow();
    expect(() => loadConfig({ ...base, BACKUP_NIGHTLY_AT: '02:30' })).toThrow(/BACKUP_DIR/);
    const cfg = loadConfig({
      ...base,
      BACKUP_NIGHTLY_AT: '02:30',
      BACKUP_DIR: 'E:/backup',
      BACKUP_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    expect(cfg.BACKUP_KEEP).toBe(14);
    expect(parseBackupKey(cfg.BACKUP_KEY!)).toHaveLength(32);
    expect(() => parseBackupKey('corta')).toThrow(/32 bytes/);
  });
});
