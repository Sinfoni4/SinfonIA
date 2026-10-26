import { describeError } from '../shared/errors.js';

import type { PrismaClient } from '@prisma/client';

export async function attemptDatabaseRecovery(prisma: PrismaClient) {
  try {
    console.log('🔁 DB RECOVERY — reconnect attempt');

    await prisma.$disconnect().catch(() => {});
    await prisma.$connect();

    console.log('✅ DB RECOVERY — reconnected');

    return true;
  } catch (error: unknown) {
    console.warn('⚠️ DB RECOVERY FAILED:', describeError(error).message);
    return false;
  }
}
