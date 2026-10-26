import { runtimeState } from '../../runtime/runtime.state.js';
import { errorLabel } from '../../shared/errors.js';

import type { PrismaClient } from '@prisma/client';

/**
 * Lightweight ping to verify that the database is reachable before startup.
 * Never throws: returns status + latency.
 */
export async function checkDatabaseConnection(
  prisma: PrismaClient,
): Promise<{ ok: boolean; latencyMs: number | null }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Date.now() - start;
    runtimeState.setDatabaseReachable(true);
    console.log('✅ Database reachable');
    return { ok: true, latencyMs };
  } catch (err) {
    runtimeState.setDatabaseReachable(false);
    console.error('❌ Database NOT reachable');
    console.error(errorLabel(err));
    return { ok: false, latencyMs: null };
  }
}
