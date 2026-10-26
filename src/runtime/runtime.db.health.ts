import { describeError } from '../shared/errors.js';

import type { PrismaClient } from '@prisma/client';

export async function checkDatabaseHealth(prisma: PrismaClient) {
  const started = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;

    const latency = Date.now() - started;

    console.log(`💓 DB HEALTH OK (${latency}ms)`);

    return {
      healthy: true,
      latency,
    };
  } catch (error: unknown) {
    const details = describeError(error);
    console.error('💔 DB HEALTH FAILED:', details);

    return {
      healthy: false,
      reason: details.code ?? details.message,
    };
  }
}
