import { describeError } from '../shared/errors.js';

import type { PrismaClient } from '@prisma/client';

export async function forceDatabaseConnect(prisma: PrismaClient) {
  try {
    console.log('🔌 DB CONNECT — attempting initial connection');

    await prisma.$connect();

    console.log('✅ DB CONNECT — success');
    return { ok: true };
  } catch (error: unknown) {
    const details = describeError(error);
    console.error('❌ DB CONNECT FAILED:', details.message);

    return {
      ok: false,
      reason: details.code ?? details.message,
    };
  }
}
