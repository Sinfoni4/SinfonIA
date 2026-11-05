/** A5 / FE8: state of the system and use of the AI, for the platform console. */

export type SystemHealth = {
  checkedAt: string;
  database: { reachable: boolean; latencyMs: number | null; mode: string };
  process: { uptimeSeconds: number; memoryMb: number; node: string };
  outbox: {
    pending: number;
    processing: number;
    failed: number;
    deadLetter: number;
    oldestPendingMinutes: number | null;
    deadLetterLast24h: number;
  };
  scheduler: { lastRunAt: string | null; failedLast24h: number; runsLast24h: number };
  /** Missing on an older backend. */
  documents?: {
    pending: number;
    processing: number;
    failedLast24h: number;
    oldestPendingMinutes: number | null;
  };
  storage?: {
    driver: 'local' | 's3';
    attachments: number;
    bytes: number;
    disk: { files: number; orphanFiles: number; missingFiles: number; checkedAt: string } | null;
  } | null;
  backup?: {
    configured: boolean;
    reachable: boolean;
    last: { at: string; tables: number | null; attachments: number | null } | null;
    /** The last restore check (npm run db:verify-backup); missing on an older backend. */
    restoreCheck?: { at: string; ok: boolean; backupAt: string } | null;
  };
  services: { telegram: boolean; whatsapp: boolean; webhook: boolean; ai: string | null };
};

/** A backup older than this is reported in the warnings. */
export const BACKUP_MAX_AGE_DAYS = 7;

/** A restore check older than this is reported in the warnings. */
export const RESTORE_CHECK_MAX_AGE_DAYS = 30;

export type AiUsage = {
  days: number;
  totals: { requests: number; errors: number; tokens: number; averageLatencyMs: number | null };
  byOutcome: Array<{ outcome: string; requests: number }>;
  byDay: Array<{ day: string; requests: number; tokens: number; errors: number }>;
  byModel: Array<{ provider: string; model: string; requests: number; tokens: number }>;
  byOrganization: Array<{
    orgId: string;
    name: string;
    requests: number;
    tokens: number;
    errors: number;
  }>;
};

export const USAGE_PERIODS = [1, 7, 30] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const OUTCOME_LABELS: Record<string, string> = {
  SUCCESS: 'Risposte riuscite',
  AMBIGUOUS: 'Richieste ambigue (domanda di chiarimento)',
  REJECTED: 'Richieste non eseguibili',
  SECURITY_REJECTED: 'Bloccate dai controlli di sicurezza',
  ERROR: 'Errori del servizio IA',
  LLM_DISABLED: 'IA spenta',
  DETERMINISTIC_FALLBACK: 'Gestite senza IA',
};

export const MODE_LABELS: Record<string, string> = {
  HEALTHY: 'normale',
  DEGRADED: 'rallentato',
  CIRCUIT_OPEN: 'interrotto',
};

/** What needs attention, in plain words; empty when all is well. */
export function healthWarnings(h: SystemHealth, now = new Date()): string[] {
  const warnings: string[] = [];
  if (!h.database.reachable) warnings.push('Il database non risponde.');
  else if (h.database.mode !== 'HEALTHY') {
    warnings.push(
      `Il database funziona in modo ${MODE_LABELS[h.database.mode] ?? h.database.mode}.`,
    );
  }
  if (h.outbox.deadLetterLast24h > 0) {
    warnings.push(`${h.outbox.deadLetterLast24h} messaggi non consegnati nelle ultime 24 ore.`);
  }
  if (h.outbox.oldestPendingMinutes !== null && h.outbox.oldestPendingMinutes >= 30) {
    warnings.push(`Un messaggio aspetta la consegna da ${h.outbox.oldestPendingMinutes} minuti.`);
  }
  if (h.scheduler.failedLast24h > 0) {
    warnings.push(
      `${h.scheduler.failedLast24h} attività pianificate non riuscite nelle ultime 24 ore.`,
    );
  }
  const docs = h.documents;
  if (docs && docs.oldestPendingMinutes !== null && docs.oldestPendingMinutes >= 30) {
    warnings.push(`Un documento aspetta la lettura da ${docs.oldestPendingMinutes} minuti.`);
  }
  if (docs && docs.failedLast24h > 0) {
    warnings.push(`${docs.failedLast24h} documenti non letti nelle ultime 24 ore.`);
  }
  if (h.storage?.disk && h.storage.disk.missingFiles > 0) {
    warnings.push(`${h.storage.disk.missingFiles} allegati non hanno più il file sul disco.`);
  }
  const backup = h.backup;
  if (backup?.configured) {
    if (!backup.reachable) {
      warnings.push('La cartella dei backup non è raggiungibile: il disco è collegato?');
    } else if (!backup.last) {
      warnings.push('Nessun backup trovato nella cartella dei backup.');
    } else {
      const days = Math.floor((now.getTime() - new Date(backup.last.at).getTime()) / 86_400_000);
      if (days >= BACKUP_MAX_AGE_DAYS) warnings.push(`L'ultimo backup è di ${days} giorni fa.`);
      const check = backup.restoreCheck;
      if (check && !check.ok) {
        warnings.push("L'ultima verifica del ripristino non è riuscita.");
      } else if (
        !check ||
        Math.floor((now.getTime() - new Date(check.at).getTime()) / 86_400_000) >=
          RESTORE_CHECK_MAX_AGE_DAYS
      ) {
        warnings.push(
          `Nessuna verifica del ripristino negli ultimi ${RESTORE_CHECK_MAX_AGE_DAYS} giorni (npm run db:verify-backup).`,
        );
      }
    }
  }
  return warnings;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('it-IT');
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} g ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** Bytes in KB, MB or GB, in Italian. */
export function formatBytes(bytes: number): string {
  const units = ['byte', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toLocaleString('it-IT', { maximumFractionDigits: 1 })} ${units[unit]}`;
}
