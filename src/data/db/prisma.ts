import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

// Data Layer boundary: all DB access is routed through this client.
// No runtime migrations are executed here (non-negotiable).
export function createPrismaClient(databaseUrl: string) {
  // Prisma v7: relational DB connections use driver adapters.
  // The composition root is responsible for loading/validating env config.
  // Sessions run in UTC. Prisma sends DateTime values as UTC wall-clock time without an offset, and
  // the columns are timestamptz: on a server whose TimeZone is not UTC (e.g. Europe/Berlin)
  // PostgreSQL would read them as local time and store every timestamp shifted by the offset.
  const pool = new Pool({ connectionString: databaseUrl, options: '-c TimeZone=UTC' });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
  });
}
