/** A5 / FE8: the warnings of the state of the system and the formats of the console. */
import { describe, expect, it } from 'vitest';

import { formatUptime, healthWarnings, type SystemHealth } from './health';

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

  it('writes the uptime in days, hours or minutes', () => {
    expect(formatUptime(90_000)).toBe('1 g 1 h');
    expect(formatUptime(3_900)).toBe('1 h 5 min');
    expect(formatUptime(120)).toBe('2 min');
  });
});
