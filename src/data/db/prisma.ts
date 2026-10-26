import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

// Data Layer boundary: all DB access is routed through this client.
// No runtime migrations are executed here (non-negotiable).
export function createPrismaClient(databaseUrl: string) {
  // Prisma v7: relational DB connections use driver adapters.
  // The composition root is responsible for loading/validating env config.
  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
  });
}
