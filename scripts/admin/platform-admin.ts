/**
 * Who is a platform administrator (docs/PROGETTO_FRONTEND_V2.md §5, G4): only from this script on
 * the server, never from an interface. Every change goes to the platform audit log and takes
 * effect at the next request of the console (the role is read from the database every time).
 *
 * Usage:
 *   npx tsx scripts/admin/platform-admin.ts --list
 *   npx tsx scripts/admin/platform-admin.ts --grant persona@example.it
 *   npx tsx scripts/admin/platform-admin.ts --revoke persona@example.it
 * Env: DATABASE_URL.
 *
 * The person must already have an account (for example as administrator of an organization):
 * until the old columns are removed (MF12) every account belongs to an organization.
 */
import 'dotenv/config';

import { z } from 'zod';

import { createPrismaClient } from '../../src/data/db/prisma.js';

import type { PrismaClient } from '@prisma/client';

/** G4: fewer than this and the console can be left without anyone who can use it. */
const MIN_ADMINS = 2;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function admins(prisma: PrismaClient) {
  return prisma.user.findMany({
    where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    orderBy: { email: 'asc' },
    select: { id: true, email: true },
  });
}

async function personByEmail(prisma: PrismaClient, email: string) {
  const people = await prisma.user.findMany({
    where: { email: { equals: email.trim(), mode: 'insensitive' }, status: 'ACTIVE' },
    select: { id: true, email: true, platformRole: true },
    take: 2,
  });
  if (people.length === 0) {
    throw new Error(
      'No active account with this email: invite the person to an organization first',
    );
  }
  if (people.length > 1) throw new Error('Several accounts share this email: merge them first');
  return people[0];
}

async function setRole(prisma: PrismaClient, email: string, grant: boolean): Promise<void> {
  const person = await personByEmail(prisma, z.string().email().parse(email));
  const wanted = grant ? 'PLATFORM_ADMIN' : 'NONE';
  if (person.platformRole === wanted) {
    console.log(`${person.email}: nothing to change`);
    return;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: person.id }, data: { platformRole: wanted } }),
    prisma.platformAuditLog.create({
      data: {
        actorUserId: null,
        action: grant ? 'PLATFORM_ADMIN_GRANTED' : 'PLATFORM_ADMIN_REVOKED',
        payload: { targetUserId: person.id, via: 'script' },
      },
    }),
  ]);
  console.log(`${person.email}: ${grant ? 'now a platform administrator' : 'no longer one'}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const grant = arg('grant');
  const revoke = arg('revoke');
  if (!grant && !revoke && !process.argv.includes('--list')) {
    throw new Error('Nothing to do: --list, --grant <email> or --revoke <email>');
  }
  const prisma = createPrismaClient(url);
  try {
    if (grant) await setRole(prisma, grant, true);
    if (revoke) await setRole(prisma, revoke, false);
    const current = await admins(prisma);
    console.log(`Platform administrators (${current.length}):`);
    for (const a of current) console.log(`  ${a.email}`);
    if (current.length < MIN_ADMINS) {
      console.log(`Warning: fewer than ${MIN_ADMINS} platform administrators (G4).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`Not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
