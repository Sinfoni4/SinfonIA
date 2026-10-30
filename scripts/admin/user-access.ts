/**
 * Platform operations on a person's access (MF5), for the technical administrator until the
 * dashboard exists. Every change takes effect at the person's next request and is audited.
 *
 * Usage:
 *   npx tsx scripts/admin/user-access.ts --user <uuid> --revoke-sessions
 *   npx tsx scripts/admin/user-access.ts --user <uuid> --status DISABLED|SUSPENDED|ACTIVE
 * Env: DATABASE_URL.
 */
import 'dotenv/config';

import { z } from 'zod';

import { revokeAllSessions, setUserStatus } from '../../src/core/identity/revocation.service.js';
import { createPrismaClient } from '../../src/data/db/prisma.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const userId = z.string().uuid().parse(arg('user'));
  const status = arg('status');
  const revokeSessions = process.argv.includes('--revoke-sessions');
  if (!status && !revokeSessions) throw new Error('Nothing to do: --status or --revoke-sessions');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(url);
  try {
    // Platform operations have no member as actor (audit user_id null).
    if (status) {
      await setUserStatus(
        prisma,
        userId,
        z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).parse(status),
        { userId: null },
      );
      console.log(`Status set to ${status}`);
    }
    if (revokeSessions) {
      await revokeAllSessions(prisma, userId, { userId: null });
      console.log('All sessions and tokens revoked');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`Not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
