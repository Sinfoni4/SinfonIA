import 'dotenv/config';

import { pgDriverCheck } from './db.pgCheck.js';
import { prismaRawCheck } from './db.prismaCheck.js';
import { tcpDatabaseCheck } from './db.tcpCheck.js';
import { analyzeDatabaseUrl } from './db.urlCheck.js';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runOne(label: string, fn: () => Promise<boolean>): Promise<boolean> {
  console.log(`\n===== ${label} =====`);
  return await fn();
}

async function runDbDiagnostics(): Promise<void> {
  const urlAnalysis = analyzeDatabaseUrl();

  const tcpOk = await runOne('TCP CHECK', async () => {
    // Even if URL parsing fails, TCP check still targets 127.0.0.1:5432 by requirement.
    return await tcpDatabaseCheck();
  });

  await sleep(1000);

  const pgOk = await runOne('PG DRIVER CHECK', async () => {
    // pg check requires DATABASE_URL.
    return await pgDriverCheck();
  });

  await sleep(1000);

  const prismaOk = await runOne('PRISMA RAW TEST', async () => {
    return await prismaRawCheck();
  });

  const summaryTcp = tcpOk ? 'OK' : 'FAIL';
  const summaryPg = pgOk ? 'OK' : 'FAIL';
  const summaryPrisma = prismaOk ? 'OK' : 'FAIL';

  console.log('\n========================');
  console.log('DB DIAGNOSTIC SUMMARY');
  console.log(`tcp: ${summaryTcp}`);
  console.log(`pg: ${summaryPg}`);
  console.log(`prisma: ${summaryPrisma}`);
  console.log('========================');

  // Lightweight final classification (no fixes, only diagnosis).
  let layer = 'UNKNOWN';
  if (!urlAnalysis.ok) layer = 'ENV CONFIG';
  else if (!tcpOk) layer = 'NETWORK';
  else if (tcpOk && !pgOk) layer = 'POSTGRES';
  else if (tcpOk && pgOk && !prismaOk) layer = 'PRISMA CLIENT';
  else layer = 'WATCHER/RECONNECT (needs runtime test)';

  console.log(`DIAGNOSTIC LAYER GUESS: ${layer}`);
}

runDbDiagnostics().catch((e) => {
  console.error('DB DIAGNOSTICS RUNNER FATAL:', e);
  process.exitCode = 1;
});
