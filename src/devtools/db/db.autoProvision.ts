import { createPrismaClient } from '../../data/db/prisma.js';

import { ensureDatabaseExists } from './database.ensure.js';
import { detectPostgresEnvironment } from './postgres.detect.js';
import { installPostgresIfMissing } from './postgres.install.js';
import { ensurePostgresRunning } from './postgres.start.js';
import { verifyPrismaConnection } from './prisma.verify.js';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`auto-provision timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

export async function autoProvisionDatabase(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;

  const timeoutMs = 20_000;

  await withTimeout(
    (async () => {
      const env = await detectPostgresEnvironment();

      if (!env.installed) {
        await installPostgresIfMissing();
      }

      if (!env.portListening || !env.running) {
        await ensurePostgresRunning();
      }

      await ensureDatabaseExists();

      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('DATABASE_URL missing; cannot verify Prisma');
      }

      const prisma = createPrismaClient(databaseUrl);
      try {
        await verifyPrismaConnection(prisma);
      } finally {
        await prisma.$disconnect().catch(() => {});
      }

      console.log('🟢 DEV DATABASE READY');
    })(),
    timeoutMs,
  );
}
