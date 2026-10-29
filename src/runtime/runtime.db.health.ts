import { describeError } from '../shared/errors.js';
import { log } from '../shared/log.js';

import type { PrismaClient } from '@prisma/client';

export async function checkDatabaseHealth(prisma: PrismaClient) {
  const started = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;

    const latency = Date.now() - started;

    log.debug({ latencyMs: latency }, 'Database health check passed');

    return {
      healthy: true,
      latency,
    };
  } catch (error: unknown) {
    const details = describeError(error);
    log.error(
      { error: details.name ?? 'Error', code: details.code },
      'Database health check failed',
    );

    return {
      healthy: false,
      reason: details.code ?? details.message,
    };
  }
}
