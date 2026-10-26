import { describeError } from '../exec.js';

import type { PrismaClient } from '@prisma/client';

export async function verifyPrismaConnection(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Prisma connectivity verified');
  } catch (err: unknown) {
    const message = describeError(err).message;
    throw new Error(`Prisma connectivity verification failed: ${message}`);
  }
}
