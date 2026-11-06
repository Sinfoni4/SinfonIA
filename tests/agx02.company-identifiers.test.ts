/**
 * AGX-02 (TerreFVG, model A): the identifiers of a company. The codice fiscale (also the CUAA of
 * a farm) and the partita IVA are checked with their check character; the administrator and the
 * platform console change them, the console also sets the codes in other systems. The audit says
 * which ones changed, never their values, and the networks never see them.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listNetworkMembers } from '../src/core/network/network.service.js';
import {
  CompanyIdentifiersError,
  elevenDigitCheck,
  normalizeExternalRefs,
  normalizeTaxCode,
  normalizeVatNumber,
  personCodeCheck,
} from '../src/core/organization/company-identifiers.js';
import {
  getOrganizationSettings,
  updateOrganizationSettings,
} from '../src/core/organization/organization-settings.service.js';
import {
  getOrganization,
  setOrganizationIdentifiers,
} from '../src/core/platform/platform.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { mapErrorToHttp } from '../src/interface/http/errors/error-mapper.js';

import type { PrismaClient } from '@prisma/client';

// Synthetic codes with a correct check character (no real person or company).
const PERSON_CODE = 'RSSMRA85T10A562S';
const VAT = '12345678903';

describe('checking the identifiers', () => {
  it('computes the check characters', () => {
    expect(personCodeCheck(PERSON_CODE.slice(0, 15))).toBe('S');
    expect(elevenDigitCheck(VAT.slice(0, 10))).toBe(3);
  });

  it('accepts a codice fiscale of 16 characters or 11 digits, cleaned up', () => {
    expect(normalizeTaxCode(' rssmra85t10a562s ')).toBe(PERSON_CODE);
    expect(normalizeTaxCode('123 456 789 03')).toBe(VAT);
    expect(normalizeTaxCode('')).toBeNull();
    expect(normalizeTaxCode(null)).toBeNull();
    expect(normalizeTaxCode(undefined)).toBeUndefined();
  });

  it('refuses a wrong check character, length or format', () => {
    for (const bad of ['RSSMRA85T10A562X', '12345678900', '00000000000', 'RSSMRA85', 'ABC']) {
      expect(() => normalizeTaxCode(bad)).toThrow(CompanyIdentifiersError);
    }
  });

  it('accepts a partita IVA with or without IT, and refuses a wrong one', () => {
    expect(normalizeVatNumber('IT 12345678903')).toBe(VAT);
    expect(normalizeVatNumber('')).toBeNull();
    expect(() => normalizeVatNumber('12345678901')).toThrow(/Partita IVA non valida/);
    expect(() => normalizeVatNumber(PERSON_CODE)).toThrow(CompanyIdentifiersError);
  });

  it('checks the codes in other systems', () => {
    expect(normalizeExternalRefs({ ' Odoo ': ' res.partner/42 ' })).toEqual({
      odoo: 'res.partner/42',
    });
    expect(normalizeExternalRefs({})).toBeNull();
    expect(() => normalizeExternalRefs({ 'sistema esterno': 'x' })).toThrow(/non valido/);
    expect(() => normalizeExternalRefs({ odoo: '' })).toThrow(/da 1 a 128/);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, 'x']));
    expect(() => normalizeExternalRefs(many)).toThrow(/Al massimo 10/);
  });

  it('answers 400 with a message to show', () => {
    expect(mapErrorToHttp(new CompanyIdentifiersError('Partita IVA non valida'))).toEqual({
      statusCode: 400,
      code: 'COMPANY_IDENTIFIERS_INVALID',
      message: 'Partita IVA non valida',
    });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('company identifiers with PostgreSQL (AGX-02)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let companyId = '';
  let networkId = '';
  let adminId = '';
  let platformAdminId = '';

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    companyId = (await tenants.createTenant({ name: `agx02-azienda-${run}` })).id;
    networkId = (await tenants.createTenant({ name: `agx02-rete-${run}` })).id;
    await prisma.tenant.update({ where: { id: networkId }, data: { type: 'NETWORK' } });
    await prisma.organizationRelation.create({
      data: { parentOrgId: networkId, childOrgId: companyId, status: 'ACTIVE' },
    });
    const users = new UserRepository(prisma);
    adminId = (
      await users.createUser(companyId, { email: `admin-${run}@agx02.local`, role: 'ADMIN' })
    ).id;
    platformAdminId = (
      await users.createUser(networkId, { email: `gestore-${run}@agx02.local`, role: 'ADMIN' })
    ).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('lets the administrator set them, and records which changed without the values', async () => {
    const settings = await updateOrganizationSettings(
      prisma,
      companyId,
      { taxCode: 'rssmra85t10a562s', vatNumber: 'IT12345678903' },
      { userId: adminId },
    );
    expect(settings).toMatchObject({ taxCode: PERSON_CODE, vatNumber: VAT });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: companyId, eventType: 'ORGANIZATION_SETTINGS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.payload).toEqual({ taxCode: 'set', vatNumber: 'set' });
    expect(JSON.stringify(audit.payload)).not.toContain(VAT);
  });

  it('refuses a wrong code without changing anything', async () => {
    await expect(
      updateOrganizationSettings(
        prisma,
        companyId,
        { name: 'Nome nuovo', vatNumber: '12345678901' },
        { userId: adminId },
      ),
    ).rejects.toThrow(CompanyIdentifiersError);
    const settings = await getOrganizationSettings(prisma, companyId);
    expect(settings).toMatchObject({ name: `agx02-azienda-${run}`, vatNumber: VAT });
  });

  it('removes one with an empty value', async () => {
    await updateOrganizationSettings(prisma, companyId, { taxCode: '' }, { userId: adminId });
    expect((await getOrganizationSettings(prisma, companyId)).taxCode).toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: companyId, eventType: 'ORGANIZATION_SETTINGS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.payload).toEqual({ taxCode: 'removed' });
  });

  it('lets the console set them with the codes in other systems, in both audit logs', async () => {
    const result = await setOrganizationIdentifiers(
      prisma,
      companyId,
      { taxCode: VAT, externalRefs: { odoo: 'res.partner/42' } },
      { userId: platformAdminId },
    );
    expect(result).toEqual({
      taxCode: VAT,
      vatNumber: VAT,
      externalRefs: { odoo: 'res.partner/42' },
    });
    expect((await getOrganization(prisma, companyId)).identifiers).toEqual(result);

    const platformLog = await prisma.platformAuditLog.findFirstOrThrow({
      where: { orgId: companyId, action: 'ORGANIZATION_IDENTIFIERS_CHANGED' },
    });
    expect(platformLog.payload).toEqual({ taxCode: 'set', externalRefs: ['odoo'] });
    const orgLog = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: companyId, eventType: 'ORGANIZATION_IDENTIFIERS_CHANGED' },
    });
    expect(orgLog).toMatchObject({ userId: null, payload: { byPlatform: true } });

    // The same values again: nothing changes, nothing is recorded.
    await setOrganizationIdentifiers(
      prisma,
      companyId,
      { taxCode: VAT, externalRefs: { odoo: 'res.partner/42' } },
      { userId: platformAdminId },
    );
    expect(
      await prisma.platformAuditLog.count({
        where: { orgId: companyId, action: 'ORGANIZATION_IDENTIFIERS_CHANGED' },
      }),
    ).toBe(1);

    // Empty refs remove them.
    const cleared = await setOrganizationIdentifiers(
      prisma,
      companyId,
      { externalRefs: {} },
      { userId: platformAdminId },
    );
    expect(cleared.externalRefs).toEqual({});
    const stored = await prisma.tenant.findUniqueOrThrow({ where: { id: companyId } });
    expect(stored.externalRefs).toBeNull();
  });

  it('never shows them to a network', async () => {
    const [member] = await listNetworkMembers(prisma, networkId);
    expect(member.orgId).toBe(companyId);
    expect(JSON.stringify(member)).not.toContain(VAT);
    expect(member).not.toHaveProperty('taxCode');
    expect(member).not.toHaveProperty('vatNumber');
  });
});
