/**
 * The demo data of the pilot scenario (scripts/demo/pilot-seed.ts) are created through the
 * application's services and only once. A tag keeps this copy apart from the demo one.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PILOT_ACCOUNTS, seedPilotScenario } from '../scripts/demo/pilot-seed.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('demo data of the pilot scenario', () => {
  const tag = `t${randomUUID().slice(0, 8)}`;
  let prisma: PrismaClient;
  let practices: PracticeApplicationService;
  let storageDir = '';

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    storageDir = mkdtempSync(path.join(tmpdir(), 'pilot-seed-'));
    practices = new PracticeApplicationService(prisma, {
      storageService: new LocalStorageService(storageDir),
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('creates the network, its companies and the consultant, once', async () => {
    const now = new Date('2026-11-05T09:00:00Z');
    const first = await seedPilotScenario(prisma, practices, { tag, now });
    expect(first.created).toBe(true);

    const relations = await prisma.organizationRelation.groupBy({
      by: ['status'],
      where: { parentOrgId: first.networkId },
      _count: true,
    });
    expect(Object.fromEntries(relations.map((r) => [r.status, r._count]))).toEqual({
      ACTIVE: 4,
      PENDING: 1,
    });

    const own = await prisma.practice.findMany({
      where: { tenantId: first.companyId },
      select: { status: true, payload: true },
    });
    expect(own).toHaveLength(4);
    expect(
      own.map((p) => [p.status, (p.payload as { subState?: string }).subState]).sort(),
    ).toEqual(
      [
        ['COMPLETED', undefined],
        ['CREATED', 'collecting_documents'],
        ['SUBMITTED', 'integration_requested'],
        ['SUBMITTED', 'under_review'],
      ].sort(),
    );
    expect(await prisma.complianceDeadline.count({ where: { tenantId: first.companyId } })).toBe(4);
    expect(await prisma.practiceAttachment.count({ where: { tenantId: first.companyId } })).toBe(1);

    const consultant = await prisma.user.findFirstOrThrow({
      where: { email: PILOT_ACCOUNTS.consultant.replace('@', `.${tag}@`) },
      select: { id: true, memberships: { select: { orgId: true } } },
    });
    expect(consultant.memberships).toEqual([{ orgId: first.consultantOrgId }]);
    const grants = await prisma.accessGrant.findMany({
      where: { granteeUserId: consultant.id },
      select: { grantorOrgId: true, operations: true },
    });
    expect(grants).toEqual([{ grantorOrgId: first.companyId, operations: ['READ', 'UPDATE'] }]);

    const again = await seedPilotScenario(prisma, practices, { tag, now });
    expect(again).toMatchObject({ created: false, networkId: first.networkId });
  });
});
