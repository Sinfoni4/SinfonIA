/**
 * B4: the nightly encrypted backup, run by the application itself (no task scheduler on the PC to
 * configure). Once a day, after the chosen time, it makes a verified backup of the database and of
 * the attachments, then keeps only the newest ones. A failed attempt is retried after an hour, at
 * most three times a day; the outcome is shown on the system health page.
 */
import {
  listBackups,
  rotateBackups,
  runEncryptedBackup,
  type BackupOptions,
  type BackupResult,
} from '../../data/backup/encrypted-backup.js';
import { errorLabel } from '../../shared/errors.js';

export type NightlyBackupStatus = {
  /** The time of day of the backup, HH:MM (local time of the server). */
  at: string;
  keep: number;
  lastRun: { at: Date; ok: boolean } | null;
};

type Log = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type NightlyBackupOptions = {
  at: string;
  keep: number;
  backup: BackupOptions;
  /** The database name: the folders of its backups start with it. */
  database: string;
  log: Log;
  /** For the tests. */
  run?: (options: BackupOptions) => Promise<BackupResult>;
  now?: () => Date;
};

const RETRY_MS = 60 * 60_000;
const MAX_ATTEMPTS_PER_DAY = 3;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isBackupTime(value: string): boolean {
  return TIME.test(value);
}

/** Today's backup time, in the local time of the server. */
export function scheduledAt(at: string, now: Date): Date {
  const m = TIME.exec(at);
  if (!m) throw new Error('BACKUP_NIGHTLY_AT must be HH:MM');
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

let current: NightlyBackup | null = null;

/** The status of the nightly backup of this process, for the health page (null: not active). */
export function nightlyBackupStatus(): NightlyBackupStatus | null {
  return current?.status() ?? null;
}

/** Makes this the backup shown on the health page. */
export function registerNightlyBackup(backup: NightlyBackup): NightlyBackup {
  current = backup;
  return backup;
}

export class NightlyBackup {
  private lastRun: { at: Date; ok: boolean } | null = null;
  private attempts: { day: string; count: number; last: Date | null } = {
    day: '',
    count: 0,
    last: null,
  };

  constructor(private readonly options: NightlyBackupOptions) {}

  status(): NightlyBackupStatus {
    return { at: this.options.at, keep: this.options.keep, lastRun: this.lastRun };
  }

  /** Called every few minutes: makes the backup when it is due. */
  async tick(): Promise<Record<string, number>> {
    const now = this.options.now?.() ?? new Date();
    const due = scheduledAt(this.options.at, now);
    if (now < due) return { skipped: 1 };
    const day = due.toDateString();
    if (this.attempts.day !== day) this.attempts = { day, count: 0, last: null };
    if (this.attempts.count >= MAX_ATTEMPTS_PER_DAY) return { skipped: 1 };
    if (this.attempts.last && now.getTime() - this.attempts.last.getTime() < RETRY_MS) {
      return { skipped: 1 };
    }

    const { backupDir } = this.options.backup;
    try {
      // Already done today (also by hand, or before a restart).
      const [newest] = await listBackups(backupDir, this.options.database);
      if (newest && newest.createdAt >= due) {
        this.lastRun ??= { at: newest.createdAt, ok: true };
        return { skipped: 1 };
      }
    } catch (err: unknown) {
      return this.failed(now, err, 'Nightly backup folder not reachable');
    }

    this.attempts.count++;
    this.attempts.last = now;
    let result: BackupResult;
    try {
      result = await (this.options.run ?? runEncryptedBackup)(this.options.backup);
    } catch (err: unknown) {
      return this.failed(now, err, 'Nightly backup failed');
    }
    this.lastRun = { at: this.options.now?.() ?? new Date(), ok: true };
    let removed: string[] = [];
    try {
      removed = await rotateBackups(backupDir, this.options.database, this.options.keep);
    } catch (err: unknown) {
      this.options.log.error({ error: errorLabel(err) }, 'Rotation of old backups failed');
    }
    this.options.log.info(
      { tables: result.tables, attachments: result.attachments, removed: removed.length },
      'Nightly backup done',
    );
    return { backups: 1, removed: removed.length };
  }

  private failed(now: Date, err: unknown, msg: string): Record<string, number> {
    this.attempts.last = now;
    this.lastRun = { at: now, ok: false };
    // The class of the error only: messages of the tools may quote paths or data.
    this.options.log.error({ error: errorLabel(err) }, msg);
    return { failed: 1 };
  }
}
