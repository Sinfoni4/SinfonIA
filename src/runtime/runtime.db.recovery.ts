import { describeError } from '../shared/errors.js';
import { log } from '../shared/log.js';

import type { PrismaClient } from '@prisma/client';

export async function attemptDatabaseRecovery(prisma: PrismaClient) {
  try {
    await prisma.$disconnect().catch(() => {});
    await prisma.$connect();

    log.info('Database reconnected');

    return true;
  } catch (error: unknown) {
    log.warn({ error: describeError(error).name ?? 'Error' }, 'Database reconnection failed');
    return false;
  }
}
