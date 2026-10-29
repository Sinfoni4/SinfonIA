import { describeError } from '../shared/errors.js';
import { log } from '../shared/log.js';

import type { PrismaClient } from '@prisma/client';

export async function forceDatabaseConnect(prisma: PrismaClient) {
  try {
    await prisma.$connect();

    log.info('Database connected');
    return { ok: true };
  } catch (error: unknown) {
    const details = describeError(error);
    log.error({ error: details.name ?? 'Error', code: details.code }, 'Database connection failed');

    return {
      ok: false,
      reason: details.code ?? details.message,
    };
  }
}
