import 'dotenv/config';

import { createPrismaClient } from '../src/data/db/prisma.js';

type ExplainResult = Array<{ 'QUERY PLAN': string }>;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL is not set');
    process.exit(1);
  }

  const prisma = createPrismaClient(databaseUrl);
  await prisma.$connect();

  console.log('🔍 Running Phase 2D EXPLAIN Query Plan Verifications...\n');

  try {
    // Ensure planner evaluates index plans regardless of test data cardinality
    await prisma.$executeRawUnsafe('SET enable_seqscan = off');

    // 1. Index scan on practice (tenant_id, status)
    console.log('--- 1. Practice Tenant + Status Query Plan ---');
    const q1 = await prisma.$queryRawUnsafe<ExplainResult>(
      `EXPLAIN SELECT * FROM "practice" WHERE "tenant_id" = '00000000-0000-0000-0000-000000000000' AND "status" = 'CREATED' ORDER BY "created_at" DESC`,
    );
    for (const row of q1) {
      console.log('  ', row['QUERY PLAN']);
    }

    // 2. GIN Index on practice payload
    console.log('\n--- 2. Practice Payload GIN Query Plan ---');
    const q2 = await prisma.$queryRawUnsafe<ExplainResult>(
      `EXPLAIN SELECT * FROM "practice" WHERE "tenant_id" = '00000000-0000-0000-0000-000000000000' AND "payload" @> '{"type": "music_practice"}'`,
    );
    for (const row of q2) {
      console.log('  ', row['QUERY PLAN']);
    }

    // 3. Unique Index on scheduler_run idempotency_key
    console.log('\n--- 3. Scheduler Run Idempotency Key Query Plan ---');
    const q3 = await prisma.$queryRawUnsafe<ExplainResult>(
      `EXPLAIN SELECT * FROM "scheduler_run" WHERE "idempotency_key" = 'tenant:task:frequency:period'`,
    );
    for (const row of q3) {
      console.log('  ', row['QUERY PLAN']);
    }

    console.log('\n✅ All Phase 2D EXPLAIN query plans analyzed successfully.');
  } catch (err) {
    console.error('❌ Failed to run EXPLAIN queries:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
