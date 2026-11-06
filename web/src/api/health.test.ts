/** A5 / FE8: the warnings of the state of the system and the formats of the console. */
import { describe, expect, it } from 'vitest';

import { formatBytes, formatUptime, healthWarnings, type SystemHealth } from './health';

const HEALTHY: SystemHealth = {
  checkedAt: '2026-11-05T10:00:00Z',
  database: { reachable: true, latencyMs: 3, mode: 'HEALTHY' },
  process: { uptimeSeconds: 3600, memoryMb: 120, node: 'v22.0.0' },
  outbox: {
    pending: 0,
    processing: 0,
    failed: 0,
    deadLetter: 2,
    oldestPendingMinutes: null,
    deadLetterLast24h: 0,
  },
  scheduler: { lastRunAt: '2026-11-05T09:00:00Z', failedLast24h: 0, runsLast24h: 24 },
  services: { telegram: true, whatsapp: false, webhook: false, ai: 'mistral' },
};

describe('state of the system (A5)', () => {
  it('has nothing to say when all is well, old dead letters included', () => {
    expect(healthWarnings(HEALTHY)).toEqual([]);
  });

  it('names what needs attention', () => {
    expect(
      healthWarnings({
        ...HEALTHY,
        database: { reachable: true, latencyMs: 900, mode: 'DEGRADED' },
        outbox: { ...HEALTHY.outbox, oldestPendingMinutes: 45, deadLetterLast24h: 3 },
        scheduler: { ...HEALTHY.scheduler, failedLast24h: 1 },
      }),
    ).toEqual([
      'Il database funziona in modo rallentato.',
      '3 messaggi non consegnati nelle ultime 24 ore.',
      'Un messaggio aspetta la consegna da 45 minuti.',
      '1 attività pianificate non riuscite nelle ultime 24 ore.',
    ]);
    expect(
      healthWarnings({ ...HEALTHY, database: { reachable: false, latencyMs: null, mode: 'X' } }),
    ).toEqual(['Il database non risponde.']);
  });

  it('names documents waiting, missing files and an old or unreachable backup', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const base = {
      ...HEALTHY,
      documents: { pending: 2, processing: 0, failedLast24h: 1, oldestPendingMinutes: 40 },
      storage: {
        driver: 'local' as const,
        attachments: 10,
        bytes: 1024,
        disk: { files: 11, orphanFiles: 2, missingFiles: 1, checkedAt: '2026-11-20T09:55:00Z' },
      },
    };
    expect(
      healthWarnings(
        {
          ...base,
          backup: {
            configured: true,
            reachable: true,
            last: { at: '2026-11-05T16:46:40Z', tables: 26, attachments: 5 },
          },
        },
        now,
      ),
    ).toEqual([
      'Un documento aspetta la lettura da 40 minuti.',
      '1 documenti non letti nelle ultime 24 ore.',
      '1 allegati non hanno più il file sul disco.',
      "L'ultimo backup è di 14 giorni fa.",
      'Nessuna verifica del ripristino negli ultimi 30 giorni (npm run db:verify-backup).',
    ]);
    const backup = (restoreCheck: { at: string; ok: boolean } | null) => ({
      configured: true,
      reachable: true,
      last: { at: '2026-11-19T22:00:00Z', tables: 26, attachments: 5 },
      restoreCheck: restoreCheck && { ...restoreCheck, backupAt: '2026-11-19T22:00:00Z' },
    });
    expect(
      healthWarnings({ ...HEALTHY, backup: backup({ at: '2026-11-20T01:00:00Z', ok: true }) }, now),
    ).toEqual([]);
    expect(
      healthWarnings(
        { ...HEALTHY, backup: backup({ at: '2026-11-20T01:00:00Z', ok: false }) },
        now,
      ),
    ).toEqual(["L'ultima verifica del ripristino non è riuscita."]);
    expect(
      healthWarnings({ ...HEALTHY, backup: backup({ at: '2026-10-01T01:00:00Z', ok: true }) }, now),
    ).toEqual([
      'Nessuna verifica del ripristino negli ultimi 30 giorni (npm run db:verify-backup).',
    ]);
    expect(
      healthWarnings(
        { ...HEALTHY, backup: { configured: true, reachable: false, last: null } },
        now,
      ),
    ).toEqual(['La cartella dei backup non è raggiungibile: il disco è collegato?']);
    // Orphan files and a backup folder not configured here are not warnings.
    expect(
      healthWarnings(
        {
          ...HEALTHY,
          storage: { ...base.storage, disk: { ...base.storage.disk, missingFiles: 0 } },
          backup: { configured: false, reachable: false, last: null },
        },
        now,
      ),
    ).toEqual([]);
  });

  it('writes sizes in bytes, KB, MB or GB', () => {
    expect(formatBytes(512)).toBe('512 byte');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB');
  });

  it('writes the uptime in days, hours or minutes', () => {
    expect(formatUptime(90_000)).toBe('1 g 1 h');
    expect(formatUptime(3_900)).toBe('1 h 5 min');
    expect(formatUptime(120)).toBe('2 min');
  });
});
