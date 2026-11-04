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
  services: { telegram: boolean; whatsapp: boolean; webhook: boolean; ai: string | null };
};

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
export function healthWarnings(h: SystemHealth): string[] {
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
