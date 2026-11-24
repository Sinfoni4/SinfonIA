/**
 * The person to remind of an expiry in a register (e.g. the holder of a licence): an active
 * person of the organization, only oneself for a member; the deadline becomes theirs, so the
 * reminders reach them too; the export names them.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COMPLIANCE_DEADLINE_REMINDER,
  ComplianceService,
} from '../src/core/compliance/compliance.service.js';
import { personLabel, SectorRecordService } from '../src/core/sector/sector-records.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { Principal } from '../src/core/authz/authorization.service.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('label of a person in a register', () => {
  it('is the email, or a chat-only account told apart by the end of its id', () => {
    expect(personLabel({ id: 'a', email: 'marco@collio.it' })).toBe('marco@collio.it');
    expect(
      personLabel({
        id: '1b2c3d4e-0000-4000-8000-00000000abcd',
        email: 'telegram-x@local.invalid',
      }),
    ).toBe('Account solo chat (…abcd)');
  });
});

describe.runIf(Boolean(DATABASE_URL))('person to remind with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let service: SectorRecordService;
  let orgId = '';
  const ids: Record<string, string> = {};
  const as = (who: string, role: UserRole): Principal => ({
    tenantId: orgId,
    userId: ids[who],
    role,
    customPermissions: null,
  });
  const admin = () => as('admin', 'ADMIN');
  const member = () => as('marco', 'MEMBER');
  const license = (extra: Record<string, unknown> = {}) => ({
    holder: 'Marco T.',
    licenseType: 'plant_protection',
    expiresOn: '2026-12-10',
    ...extra,
  });
  const deadlineOf = (recordId: string) =>
    prisma.complianceDeadline.findUniqueOrThrow({
      where: { sectorRecordId: recordId },
      select: { id: true, userId: true },
    });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Avvisi ${run}`, module: 'agri' })
    ).id;
    await prisma.tenant.update({
      where: { id: orgId },
      data: { enabledFeatures: ['trade_licenses', 'field_book'] },
    });
    const users = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['marco', 'MEMBER'],
      ['elisa', 'MEMBER'],
    ] as const) {
      ids[who] = (await users.createUser(orgId, { email: `${who}-${run}@notify.local`, role })).id;
    }
    // Someone of another organization.
    const other = await new TenantRepository(prisma).createTenant({
      name: `Altra ${run}`,
      module: 'agri',
    });
    ids.stranger = (
      await users.createUser(other.id, { email: `stranger-${run}@notify.local`, role: 'ADMIN' })
    ).id;
    service = new SectorRecordService(prisma, {
      clock: () => new Date('2026-11-24T09:00:00Z'),
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('makes the deadline of the person named, who gets the reminder too', async () => {
    const entry = await service.create(admin(), {
      feature: 'trade_licenses',
      channel: 'dashboard',
      kind: 'license',
      data: license({ notify: ids.marco }),
    });
    expect(entry.notify).toEqual({ id: ids.marco, label: `marco-${run}@notify.local` });
    const deadline = await deadlineOf(entry.id);
    expect(deadline.userId).toBe(ids.marco);

    await new ComplianceService(prisma, () => new Date('2026-11-24T09:00:00Z')).sendDueReminders({
      tenantId: orgId,
      deadlineId: deadline.id,
    });
    const reminder = await prisma.outboxMessage.findFirst({
      where: { tenantId: orgId, eventType: COMPLIANCE_DEADLINE_REMINDER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    expect((reminder?.payload as { userId?: string } | undefined)?.userId).toBe(ids.marco);

    // Cleared on a change: the deadline is the organization's again.
    await service.update(admin(), {
      feature: 'trade_licenses',
      channel: 'dashboard',
      id: entry.id,
      data: license(),
    });
    expect((await deadlineOf(entry.id)).userId).toBeNull();
  });

  it('offers the people of the organization to staff, only oneself to a member', async () => {
    const forAdmin = await service.list(admin(), {
      feature: 'trade_licenses',
      channel: 'dashboard',
    });
    expect(forAdmin.people.map((p) => p.id).sort()).toEqual(
      [ids.admin, ids.marco, ids.elisa].sort(),
    );
    const forMember = await service.list(member(), {
      feature: 'trade_licenses',
      channel: 'dashboard',
    });
    expect(forMember.people.map((p) => p.id)).toEqual([ids.marco]);
    // A register whose entries name nobody offers nobody.
    const fieldBook = await service.list(admin(), { feature: 'field_book', channel: 'dashboard' });
    expect(fieldBook.people).toEqual([]);
  });

  it('refuses someone else for a member, a stranger, and a kind that names nobody', async () => {
    const create = (who: Principal, feature: string, kind: string, data: object) =>
      service.create(who, { feature, channel: 'dashboard', kind, data });
    await expect(
      create(member(), 'trade_licenses', 'license', license({ notify: ids.elisa })),
    ).rejects.toThrow('solo te stesso');
    const mine = await create(
      member(),
      'trade_licenses',
      'license',
      license({ notify: ids.marco }),
    );
    expect(mine.notify?.id).toBe(ids.marco);

    await expect(
      create(admin(), 'trade_licenses', 'license', license({ notify: ids.stranger })),
    ).rejects.toThrow('non è tra le persone');
    await expect(
      create(admin(), 'trade_licenses', 'license', license({ notify: 'not-an-id' })),
    ).rejects.toThrow('non valido');
    await expect(
      create(admin(), 'field_book', 'harvest', {
        date: '2026-11-20',
        plot: 'Vigna',
        crop: 'Vite',
        notify: ids.marco,
      }),
    ).rejects.toThrow('non valido');
  });

  it('names the person in the CSV of the register', async () => {
    await service.create(admin(), {
      feature: 'trade_licenses',
      channel: 'dashboard',
      kind: 'license',
      data: license({ holder: 'Elisa P.', notify: ids.elisa }),
    });
    const file = await service.export(admin(), {
      feature: 'trade_licenses',
      channel: 'dashboard',
      format: 'csv',
    });
    const csv = file.content.toString('utf8');
    expect(csv).toContain('"Persona da avvisare"');
    expect(csv).toContain(`"elisa-${run}@notify.local"`);
  });
});
