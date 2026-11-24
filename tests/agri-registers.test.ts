/**
 * The registers of the agricultural functions (DVR, farm file and CAP, farm fuel, organic
 * certifications, training and safety): every declaration is consistent, an expiry becomes a
 * deadline of the right category in each sector, and the PDF writes an amount with its unit.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { entryDetails } from '../src/core/sector/sector-records.export.js';
import { SectorRecordService } from '../src/core/sector/sector-records.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { deadlineCategoriesOf, getModule, sectorRecordKind } from '../src/modules/registry.js';
import { SECTOR_FEATURES, type SectorFeatureDefinition } from '../src/modules/sector-features.js';

import type { Principal } from '../src/core/authz/authorization.service.js';
import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
/** The catalog with its general type, so every function may have a register. */
const FEATURES: readonly SectorFeatureDefinition[] = SECTOR_FEATURES;

describe('declarations of the registers', () => {
  const agricultural = SECTOR_FEATURES.filter((f) =>
    (f.modules as readonly string[]).includes('agri'),
  );

  it('builds every agricultural function', () => {
    expect(agricultural.map((f) => [f.id, f.ready])).toEqual(agricultural.map((f) => [f.id, true]));
  });

  it('refers only to declared fields of the right type', () => {
    for (const feature of FEATURES) {
      if (!feature.ready) continue;
      const byKey = new Map<string, string>();
      for (const kind of feature.records ?? []) {
        const fields = new Map(kind.fields.map((f) => [f.key, f]));
        expect(fields.size, `${feature.id}/${kind.kind}: keys repeated`).toBe(kind.fields.length);
        for (const key of kind.titleFields)
          expect(fields.has(key), `${kind.kind}.${key}`).toBe(true);
        for (const key of [kind.dateField, kind.dueField]) {
          if (key) expect(fields.get(key)?.type, `${kind.kind}.${key}`).toBe('date');
        }
        for (const [amount, unit] of Object.entries(kind.units ?? {})) {
          expect(fields.get(amount)?.type).toBe('number');
          expect(fields.get(unit)?.type).toBe('choice');
        }
        // A key shared by kinds of the same register is one column of the export: same type.
        for (const f of kind.fields) {
          const seen = byKey.get(f.key);
          if (seen) expect(seen, `${feature.id}: ${f.key}`).toBe(f.type);
          else byKey.set(f.key, f.type);
        }
      }
    }
  });

  it('gives an expiry a category of every sector of the function, or «Altro»', () => {
    for (const feature of FEATURES) {
      for (const kind of feature.records ?? []) {
        if (!kind.deadlineCategory) continue;
        for (const module of feature.modules) {
          // A category the sector does not use falls back to ALTRO: here they all exist.
          expect(
            deadlineCategoriesOf(getModule(module)),
            `${feature.id}/${kind.kind} in ${module}`,
          ).toContain(kind.deadlineCategory);
        }
      }
    }
  });
});

describe('details of an entry in the PDF', () => {
  it('writes an amount with its unit, and the unit never alone', () => {
    const harvest = sectorRecordKind('field_book', 'harvest');
    expect(entryDetails(harvest, { quantity: 30, unit: 't', notes: 'Annata buona' })).toBe(
      'Quantità: 30 tonnellate · Note: Annata buona',
    );
    expect(entryDetails(harvest, { quantity: 1.5 })).toBe('Quantità: 1,5');
    expect(entryDetails(harvest, { unit: 'q' })).toBe('');
  });

  it('leaves out the fields already in the other columns', () => {
    const withdrawal = sectorRecordKind('farm_fuel', 'withdrawal');
    expect(
      entryDetails(withdrawal, {
        date: '2026-11-20',
        fuel: 'diesel',
        liters: 500,
        supplier: 'Consorzio',
        document: 'F-12',
      }),
    ).toBe('Litri: 500 · Fattura o DDT n.: F-12');
  });
});

describe.runIf(Boolean(DATABASE_URL))('agricultural registers with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  const principals: Record<'agri' | 'artisan', Principal> = {} as never;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    for (const module of ['agri', 'artisan'] as const) {
      const tenant = await new TenantRepository(prisma).createTenant({
        name: `Registri ${module} ${run}`,
        module,
      });
      const features = SECTOR_FEATURES.filter((f) =>
        (f.modules as readonly string[]).includes(module),
      ).map((f) => f.id);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { enabledFeatures: features },
      });
      const user = await new UserRepository(prisma).createUser(tenant.id, {
        email: `admin-${module}-${run}@registers.local`,
        role: 'ADMIN',
      });
      principals[module] = {
        tenantId: tenant.id,
        userId: user.id,
        role: 'ADMIN',
        customPermissions: null,
      };
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const create = (module: 'agri' | 'artisan', feature: string, kind: string, data: object) =>
    new SectorRecordService(prisma).create(principals[module], {
      feature,
      channel: 'dashboard',
      kind,
      data,
    });
  const deadlineOf = (recordId: string) =>
    prisma.complianceDeadline.findUnique({
      where: { sectorRecordId: recordId },
      select: { category: true, title: true, dueDate: true },
    });

  it('turns each expiry into a deadline of its category', async () => {
    const cases: Array<[string, string, object, string]> = [
      [
        'risk_assessment',
        'revision',
        { date: '2026-01-10', version: 'Rev. 3', reason: 'periodic', nextReview: '2027-01-10' },
        'SICUREZZA_LAVORO',
      ],
      [
        'cap_file',
        'application',
        { date: '2026-11-20', year: 2027, applicationType: 'single', deadline: '2027-05-15' },
        'ALTRO',
      ],
      [
        'farm_fuel',
        'assignment',
        { date: '2026-02-01', year: 2026, diesel: 4000, reportDue: '2027-01-31' },
        'ALTRO',
      ],
      [
        'organic_certification',
        'certificate',
        {
          scheme: 'organic',
          body: 'ICEA',
          issuedOn: '2026-03-01',
          expiresOn: '2027-02-28',
        },
        'CERTIFICAZIONE_BIO',
      ],
      [
        'training_safety',
        'medical_check',
        { person: 'Luca B.', date: '2026-06-01', outcome: 'fit', nextVisit: '2027-06-01' },
        'VISITA_MEDICA',
      ],
    ];
    for (const [feature, kind, data, category] of cases) {
      const entry = await create('agri', feature, kind, data);
      const deadline = await deadlineOf(entry.id);
      expect(deadline?.category, `${feature}/${kind}`).toBe(category);
      const label = SECTOR_FEATURES.find((f) => f.id === feature)?.label;
      expect(deadline?.title).toBe(`${label}: ${entry.title}`);
    }
  });

  it('keeps the category in a crafts organization too', async () => {
    const course = await create('artisan', 'training_safety', 'course', {
      person: 'Anna R.',
      course: 'first_aid',
      completedOn: '2026-04-15',
      expiresOn: '2029-04-15',
    });
    expect(course.title).toBe('Primo soccorso · Anna R.');
    expect((await deadlineOf(course.id))?.category).toBe('SICUREZZA_LAVORO');
  });

  it('takes an entry without an expiry and refuses one without its required fields', async () => {
    const role = await create('agri', 'risk_assessment', 'safety_role', {
      role: 'rspp',
      person: 'Studio Rossi',
      appointedOn: '2025-09-01',
    });
    expect(role.title).toBe('RSPP · Studio Rossi');
    expect(await deadlineOf(role.id)).toBeNull();

    await expect(
      create('agri', 'farm_fuel', 'withdrawal', { date: '2026-11-20', fuel: 'diesel' }),
    ).rejects.toThrow('Litri');
  });
});
