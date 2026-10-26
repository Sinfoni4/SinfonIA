import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { describeError } from './exec.js';

export async function prismaRawCheck(): Promise<boolean> {
  console.log('🧪 PRISMA CHECK START');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('🔴 PRISMA QUERY FAIL');
    console.error('DATABASE_URL missing');
    return false;
  }

  // IMPORTANT: isolated client (do not reuse runtime singleton).
  // This repo constructs Prisma via adapter-pg + Pool.
  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('🟢 PRISMA QUERY OK');
    return true;
  } catch (err: unknown) {
    console.log('🔴 PRISMA QUERY FAIL');
    const details = describeError(err);
    console.error('PRISMA ERROR:', {
      code: details.code,
      message: details.message,
      name: details.name,
    });
    return false;
  } finally {
    await prisma.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
}
