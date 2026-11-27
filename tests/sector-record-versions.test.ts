/**
 * Fase 1A: the entries of the sector registers are never overwritten nor deleted. A change is a
 * correction with its reason and a new version; an entry is voided, with its reason, and stays in
 * the register with its history; the database refuses to change a version.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fieldListSchema } from '../src/core/modules/module.contract.js';
import { SectorRecordService } from '../src/core/sector/sector-records.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { Principal } from '../src/core/authz/authorization.service.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('decimal places of a number field', () => {
  const schema = fieldListSchema([
    { key: 'liters', label: 'Litri', type: 'number', min: 0, decimals: 2 },
    { key: 'any', label: 'Qualsiasi', type: 'number' },
  ]);

  it('accepts up to the declared places, and any without a declaration', () => {
    expect(schema.safeParse({ liters: 1250 }).success).toBe(true);
    expect(schema.safeParse({ liters: 12.5 }).success).toBe(true);
    expect(schema.safeParse({ liters: 12.55 }).success).toBe(true);
    expect(schema.safeParse({ any: 1.123456 }).success).toBe(true);
  });

  it('refuses more places than declared', () => {
    expect(schema.safeParse({ liters: 12.555 }).success).toBe(false);
  });
});

describe.runIf(Boolean(DATABASE_URL))('history of the register entries with PostgreSQL', () => {
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
  const where = { feature: 'trade_licenses', channel: 'dashboard' as const };
  const license = (extra: Record<string, unknown> = {}) => ({
    holder: `Marco ${run}`,
    licenseType: 'plant_protection',
    expiresOn: '2027-03-10',
    ...extra,
  });
  const create = (data = license()) => service.create(admin(), { ...where, kind: 'license', data });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Storico ${run}`, module: 'agri' })
    ).id;
    await prisma.tenant.update({
      where: { id: orgId },
      data: { enabledFeatures: ['trade_licenses', 'farm_fuel'] },
    });
    const users = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['marco', 'MEMBER'],
    ] as const) {
      ids[who] = (await users.createUser(orgId, { email: `${who}-${run}@storico.local`, role })).id;
    }
    service = new SectorRecordService(prisma, {
      clock: () => new Date('2026-11-27T09:00:00Z'),
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps the first version of a new entry', async () => {
    const entry = await create();
    expect(entry.version).toBe(1);
    expect(entry.voided).toBeNull();
    const history = await service.versions(admin(), { ...where, id: entry.id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      version: 1,
      action: 'CREATED',
      reason: null,
      channel: 'dashboard',
      author: `admin-${run}@storico.local`,
      data: license(),
    });
  });

  it('corrects an entry only with a reason, keeping what it said before', async () => {
    const entry = await create();
    const correct = (reason: unknown, data = license({ expiresOn: '2027-04-10' })) =>
      service.update(admin(), { ...where, id: entry.id, data, reason });

    await expect(correct(undefined)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(correct('  no ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(correct('x'.repeat(501))).rejects.toThrow('al massimo 500');
    await expect(correct('Stessa cosa', license())).rejects.toMatchObject({ code: 'NO_CHANGE' });

    const corrected = await correct('  Data di scadenza   sbagliata ');
    expect(corrected.version).toBe(2);
    expect(corrected.dueDate).toBe('2027-04-10');
    const history = await service.versions(admin(), { ...where, id: entry.id });
    expect(history.map((v) => [v.version, v.action, v.reason, v.dueDate])).toEqual([
      [1, 'CREATED', null, '2027-03-10'],
      [2, 'CORRECTED', 'Data di scadenza sbagliata', '2027-04-10'],
    ]);
    expect(history[0].data.expiresOn).toBe('2027-03-10');
  });

  it('refuses a correction made on an older version', async () => {
    const entry = await create();
    await service.update(admin(), {
      ...where,
      id: entry.id,
      data: license({ expiresOn: '2027-05-01' }),
      reason: 'Prima correzione',
      expectedVersion: 1,
    });
    await expect(
      service.update(admin(), {
        ...where,
        id: entry.id,
        data: license({ expiresOn: '2027-06-01' }),
        reason: 'Correzione da una pagina vecchia',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
  });

  it('voids an entry with its reason: kept, out of the lists, its deadline closed', async () => {
    const entry = await create(license({ holder: `Elisa ${run}` }));
    await expect(
      service.void(admin(), { ...where, id: entry.id, reason: '' }),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const voided = await service.void(admin(), {
      ...where,
      id: entry.id,
      reason: 'Patentino inserito due volte',
    });
    expect(voided.version).toBe(2);
    expect(voided.voided).toMatchObject({
      reason: 'Patentino inserito due volte',
      by: `admin-${run}@storico.local`,
      at: '2026-11-27T09:00:00.000Z',
    });

    const deadline = await prisma.complianceDeadline.findUniqueOrThrow({
      where: { sectorRecordId: entry.id },
    });
    expect(deadline.status).toBe('CLOSED');

    const ids = async (state?: 'active' | 'voided' | 'all') =>
      (
        await service.list(admin(), { ...where, ...(state ? { state } : {}), limit: 100 })
      ).items.map((i) => i.id);
    expect(await ids()).not.toContain(entry.id);
    expect(await ids('voided')).toEqual([entry.id]);
    expect(await ids('all')).toContain(entry.id);

    // Nothing changes it any more.
    await expect(
      service.update(admin(), { ...where, id: entry.id, data: license(), reason: 'Ripristino' }),
    ).rejects.toMatchObject({ code: 'VOIDED' });
    await expect(
      service.void(admin(), { ...where, id: entry.id, reason: 'Di nuovo' }),
    ).rejects.toMatchObject({ code: 'VOIDED' });

    const history = await service.versions(admin(), { ...where, id: entry.id });
    expect(history.map((v) => [v.action, v.reason])).toEqual([
      ['CREATED', null],
      ['VOIDED', 'Patentino inserito due volte'],
    ]);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: orgId, eventType: 'SECTOR_RECORD_VOIDED' },
      }),
    ).toBe(1);
  });

  it('lets a member void only their own entries', async () => {
    const theirs = await service.create(member(), {
      ...where,
      kind: 'license',
      data: license({ holder: 'Marco T.' }),
    });
    const others = await create(license({ holder: `Altro ${run}` }));
    await expect(
      service.void(member(), { ...where, id: others.id, reason: 'Non è mia' }),
    ).rejects.toThrow('Voce non trovata');
    await expect(service.versions(member(), { ...where, id: others.id })).rejects.toThrow(
      'Voce non trovata',
    );
    const voided = await service.void(member(), { ...where, id: theirs.id, reason: 'Errore mio' });
    expect(voided.voided?.reason).toBe('Errore mio');
  });

  it('exports voided entries only when asked, with the reason and the version', async () => {
    const entry = await create(license({ holder: `Export ${run}` }));
    await service.void(admin(), { ...where, id: entry.id, reason: 'Abilitazione mai rilasciata' });
    const csv = async (state?: 'active' | 'all') =>
      (
        await service.export(admin(), { ...where, format: 'csv', ...(state ? { state } : {}) })
      ).content.toString('utf8');
    expect(await csv()).not.toContain(`Export ${run}`);
    const all = await csv('all');
    expect(all).toContain(`Export ${run}`);
    expect(all).toContain('"Motivo dell’annullamento"');
    expect(all).toContain('"Abilitazione mai rilasciata"');
    expect(all).toContain('"Versione"');
  });

  it('refuses quantities with more decimal places than the register keeps', async () => {
    const fuel = { feature: 'farm_fuel', channel: 'dashboard' as const, kind: 'withdrawal' };
    const data = { date: '2026-11-20', fuel: 'diesel', liters: 120.555 };
    await expect(service.create(admin(), { ...fuel, data })).rejects.toThrow('Litri');
    const ok = await service.create(admin(), { ...fuel, data: { ...data, liters: 120.55 } });
    expect(ok.data.liters).toBe(120.55);
  });

  it('never lets the database change a version, but clears its author when asked by the FK', async () => {
    const entry = await create(license({ holder: `Db ${run}` }));
    // With the application role (as in the CI) the privilege is missing; with the owner, the
    // trigger refuses: either way the version does not change.
    const [{ app }] = await prisma.$queryRaw<Array<{ app: boolean }>>`
      SELECT NOT has_table_privilege(current_user, 'sector_record_version', 'UPDATE') AS app`;
    await expect(
      prisma.$executeRaw`UPDATE sector_record_version SET reason = 'cambiata' WHERE record_id = ${entry.id}::uuid`,
    ).rejects.toThrow(app ? /permission denied/ : /updates are not allowed/);
    if (app) {
      // Nor deleted by the application: only with its entry or its organization (cascade).
      await expect(
        prisma.$executeRaw`DELETE FROM sector_record_version WHERE record_id = ${entry.id}::uuid`,
      ).rejects.toThrow(/permission denied/);
      return;
    }
    // What ON DELETE SET NULL does when the author's account goes: allowed, nothing else changes.
    expect(
      await prisma.$executeRaw`UPDATE sector_record_version SET changed_by = NULL WHERE record_id = ${entry.id}::uuid`,
    ).toBe(1);
  });
});
