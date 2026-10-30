/**
 * MF3 (expand step): the new identity tables follow the legacy columns the application still
 * writes, and their constraints hold. docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2, §9.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyIdentityModel } from '../scripts/db/mf3-verify.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

async function sqlState(prisma: PrismaClient, sql: string): Promise<string> {
  try {
    await prisma.$executeRawUnsafe(sql);
    return 'ok';
  } catch (err) {
    const text = String((err as { message?: string }).message ?? err);
    return /23505|unique/i.test(text)
      ? 'unique'
      : /23514|check constraint/i.test(text)
        ? 'check'
        : text;
  }
}

describe.runIf(Boolean(DATABASE_URL))('MF3 identity model (expand step)', () => {
  let prisma: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    tenantA = (await tenants.createTenant({ name: `mf3-a-${run}` })).id;
    tenantB = (await tenants.createTenant({ name: `mf3-b-${run}` })).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('gives every new user a membership with the same role, and follows role changes', async () => {
    const user = await new UserRepository(prisma).createUser(tenantA, {
      email: `mf3-${run}@test.local`,
      role: 'OPERATOR',
    });
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_orgId: { userId: user.id, orgId: tenantA } },
    });
    expect(membership).toMatchObject({ role: 'OPERATOR', status: 'ACTIVE' });
    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    expect(
      (
        await prisma.membership.findUniqueOrThrow({
          where: { userId_orgId: { userId: user.id, orgId: tenantA } },
        })
      ).role,
    ).toBe('ADMIN');
  });

  it('links a Telegram account once; the most recent user wins, as in the legacy resolver', async () => {
    const telegramId = String(800000000 + Math.floor(Math.random() * 99999999));
    const users = new UserRepository(prisma);
    const first = await users.ensureTelegramUser(tenantA, telegramId);
    const active = () =>
      prisma.channelIdentity.findMany({
        where: { channel: 'TELEGRAM', externalId: telegramId, revokedAt: null },
      });
    expect((await active()).map((c) => c.userId)).toEqual([first.id]);
    // Legacy links did not verify the application account.
    expect((await active())[0]?.verifiedAt).toBeNull();

    const second = await users.ensureTelegramUser(tenantB, telegramId);
    expect((await active()).map((c) => c.userId)).toEqual([second.id]);
    const revoked = await prisma.channelIdentity.findFirstOrThrow({
      where: { channel: 'TELEGRAM', externalId: telegramId, userId: first.id },
    });
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('mirrors WhatsApp identities and revokes the link when the identity is removed', async () => {
    const user = await new UserRepository(prisma).createUser(tenantA, {
      email: `mf3-wa-${run}@test.local`,
      role: 'MEMBER',
    });
    const phone = `3933${Math.floor(Math.random() * 1e8)}`;
    await prisma.whatsappIdentity.create({
      data: { tenantId: tenantA, userId: user.id, phoneNumber: phone },
    });
    const link = () =>
      prisma.channelIdentity.findFirst({
        where: { channel: 'WHATSAPP', externalId: phone, revokedAt: null },
      });
    expect((await link())?.userId).toBe(user.id);
    await prisma.whatsappIdentity.delete({ where: { userId: user.id } });
    expect(await link()).toBeNull();
  });

  it('refuses a second active link of the same chat account', async () => {
    const user = await new UserRepository(prisma).createUser(tenantA, {
      email: `mf3-dup-${run}@test.local`,
      role: 'MEMBER',
    });
    const external = `dup-${run}`;
    const insert = `INSERT INTO channel_identity (id, user_id, channel, external_id)
                    VALUES (gen_random_uuid(), '${user.id}', 'TELEGRAM', '${external}')`;
    expect(await sqlState(prisma, insert)).toBe('ok');
    expect(await sqlState(prisma, insert)).toBe('unique');
  });

  it('enforces the delegation and relation constraints', async () => {
    const user = await new UserRepository(prisma).createUser(tenantB, {
      email: `mf3-grant-${run}@test.local`,
      role: 'MEMBER',
    });
    const grant = (granteeType: string, userId: string | null, orgId: string | null, extra = '') =>
      `INSERT INTO access_grant (id, grantor_org_id, grantee_type, grantee_user_id, grantee_org_id,
                                 scope, operations, valid_until)
       VALUES (gen_random_uuid(), '${tenantA}', '${granteeType}',
               ${userId ? `'${userId}'` : 'NULL'}, ${orgId ? `'${orgId}'` : 'NULL'},
               '{"types":["practice"]}', ${extra || `ARRAY['READ']::"GrantOperation"[]`},
               now() + interval '30 days')`;
    expect(await sqlState(prisma, grant('USER', user.id, null))).toBe('ok');
    expect(await sqlState(prisma, grant('ORGANIZATION', null, tenantB))).toBe('ok');
    // Type and grantee must match; no grant to itself; at least one operation.
    expect(await sqlState(prisma, grant('USER', null, tenantB))).toBe('check');
    expect(await sqlState(prisma, grant('ORGANIZATION', user.id, null))).toBe('check');
    expect(await sqlState(prisma, grant('ORGANIZATION', null, tenantA))).toBe('check');
    expect(
      await sqlState(prisma, grant('USER', user.id, null, `ARRAY[]::"GrantOperation"[]`)),
    ).toBe('check');
    expect(
      await sqlState(
        prisma,
        `INSERT INTO organization_relation (id, parent_org_id, child_org_id)
         VALUES (gen_random_uuid(), '${tenantA}', '${tenantA}')`,
      ),
    ).toBe('check');
  });

  it('keeps the whole database consistent with the legacy columns', async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const failed = (await verifyIdentityModel(client)).filter((c) => !c.ok);
      expect(failed).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
