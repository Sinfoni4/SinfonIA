/**
 * Adds a person to an organization with a role, for the technical administrator, while the email
 * provider is not chosen (D11) and invitations cannot reach a real mailbox. The person then logs
 * in to the dashboard with their email and the code (on screen with `staging:start --
 * --dashboard-login`). Recorded in the organization's activity log as done by the platform.
 *
 * Usage:
 *   npx tsx scripts/admin/add-member.ts --org "Nome organizzazione" --email persona@example.it
 *     [--role ADMIN|OPERATOR|MEMBER] [--staging]
 * Env: DATABASE_URL, or --staging for the local staging database (as staging:start builds it).
 */
import 'dotenv/config';

import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { createPrismaClient } from '../../src/data/db/prisma.js';
import { AuditService } from '../../src/data/services/audit.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function envValue(file: string, key: string): string {
  if (!existsSync(file)) throw new Error(`${file} not found (run from the repository folder)`);
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing in ${file}`);
  return line.slice(key.length + 1).replace(/^"|"$/g, '');
}

/** The staging database with the application role, never printed (see scripts/staging/start.ts). */
function stagingUrl(): string {
  const url = new URL(envValue('.env.test', 'DATABASE_URL'));
  url.pathname = '/sinfonia_staging';
  url.username = 'sinfonia_staging_app';
  url.password = encodeURIComponent(envValue('.env', 'DB_APP_PASSWORD'));
  return url.toString();
}

async function main() {
  const orgName = z.string().trim().min(2).parse(arg('org'));
  const email = z.string().trim().toLowerCase().email().parse(arg('email'));
  const role = z.enum(['ADMIN', 'OPERATOR', 'MEMBER']).parse(arg('role') ?? 'MEMBER');
  if (email.endsWith('@local.invalid')) throw new Error('Not a real email address');
  const url = process.argv.includes('--staging') ? stagingUrl() : process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (or --staging)');

  const prisma = createPrismaClient(url);
  try {
    const orgs = await prisma.tenant.findMany({
      where: { name: { equals: orgName, mode: 'insensitive' } },
      select: { id: true, name: true, status: true },
      take: 2,
    });
    if (orgs.length !== 1) {
      throw new Error(
        orgs.length ? 'Several organizations have this name' : 'No such organization',
      );
    }
    const org = orgs[0];
    if (org.status !== 'ACTIVE') throw new Error('The organization is not active');

    const people = await prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true },
      take: 2,
    });
    if (people.length > 1) throw new Error('Several accounts share this email: merge them first');

    const userId = await prisma.$transaction(async (tx) => {
      // Until the old columns are removed (MF12) a new account belongs to this organization.
      const id =
        people[0]?.id ??
        (await tx.user.create({ data: { tenantId: org.id, email, role }, select: { id: true } }))
          .id;
      await tx.membership.upsert({
        where: { userId_orgId: { userId: id, orgId: org.id } },
        create: { userId: id, orgId: org.id, role },
        update: {
          role,
          status: 'ACTIVE',
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
        },
      });
      await new AuditService(tx).logEvent({
        tenantId: org.id,
        userId: null,
        eventType: 'MEMBER_ADDED',
        payload: { targetUserId: id, role, byPlatform: true },
      });
      return id;
    });
    console.log(
      `${email}: ${role} in «${org.name}» (${people.length ? 'existing account' : 'new account'}, ${userId.slice(0, 8)})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`Not done: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
