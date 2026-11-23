/**
 * Registers of the functions of a sector: each call checks the sector, the channel (dashboard or
 * Mini App, chosen apart), whether the function is built and its own permission; members see
 * only their entries; an expiry keeps one deadline of the organization in step.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { recordTitle } from '../src/core/sector/sector-records.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';
import { buildServer } from '../src/interface/http/server.js';
import { sectorRecordKind } from '../src/modules/registry.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('title of an entry', () => {
  it('joins the title fields, choices by their label', () => {
    const license = sectorRecordKind('trade_licenses', 'license')!;
    expect(recordTitle(license, { holder: 'Mario Rossi', licenseType: 'plant_protection' })).toBe(
      'Patentino prodotti fitosanitari · Mario Rossi',
    );
    const harvest = sectorRecordKind('field_book', 'harvest')!;
    expect(recordTitle(harvest, { crop: 'Vite', plot: '' })).toBe('Vite');
  });
});

type Json = { data: Record<string, unknown>; error?: { code: string; message: string } };

describe.runIf(Boolean(DATABASE_URL))('sector registers', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId = '';
  const storageDir = mkdtempSync(path.join(tmpdir(), 'sinfonia-sector-'));
  const filesOnDisk = () => {
    const dir = path.join(storageDir, orgId);
    return existsSync(dir) ? readdirSync(dir).length : 0;
  };
  const people: Record<string, string> = {};

  const as = (who: string, role: UserRole) => authHeaders(orgId, people[who], role);
  const admin = () => as('admin', 'ADMIN');
  const farmer = () => as('farmer', 'MEMBER');
  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.json<Json>() };
  };
  const turnOn = (dashboard: string[], miniApp: string[]) =>
    prisma.tenant.update({
      where: { id: orgId },
      data: { enabledFeatures: dashboard, miniAppFeatures: miniApp },
    });
  const treatment = (extra: Record<string, unknown> = {}) => ({
    kind: 'treatment',
    data: {
      date: '2026-11-20',
      plot: 'Vigna nord',
      crop: 'Vite',
      product: `Rame ${run}`,
      quantity: 2.5,
      unit: 'kg_ha',
      area: 1.2,
      ...extra,
    },
  });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Azienda ${run}`, module: 'agri' })
    ).id;
    const users = new UserRepository(prisma);
    for (const [who, role] of [
      ['admin', 'ADMIN'],
      ['operator', 'OPERATOR'],
      ['farmer', 'MEMBER'],
      ['other', 'MEMBER'],
    ] as const) {
      people[who] = (
        await users.createUser(orgId, { email: `${who}-${run}@sector.local`, role })
      ).id;
    }
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3019',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-sector',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      practiceService: practices,
      complianceService: new ComplianceService(prisma),
      storage: new LocalStorageService(storageDir),
      interpreterService: new InterpreterService(llm),
      executorService: new ExecutorService({ practiceService: practices }),
      contextService: new ContextService(practices),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
    await app.ready();
  });

  afterAll(async () => {
    // Like the other files, the data stays (npm run test:db:clean empties the test database):
    // deleting an organization would leave its people without any membership.
    await app?.close();
    await prisma?.$disconnect();
  });

  it('refuses a function that is off, of another sector or not built yet', async () => {
    const off = await call('GET', '/sector/field_book/records', admin());
    expect(off.status).toBe(403);
    expect(off.body.error?.code).toBe('SECTOR_FEATURE_OFF');

    await turnOn(['field_book', 'trade_licenses', 'cap_file'], []);
    expect((await call('GET', '/sector/grants/records', admin())).status).toBe(404);
    expect((await call('GET', '/sector/unknown_thing/records', admin())).status).toBe(404);
    const building = await call('GET', '/sector/cap_file/records', admin());
    expect(building.status).toBe(409);
    expect(building.body.error?.code).toBe('SECTOR_FEATURE_NOT_READY');
  });

  it('keeps the dashboard and the Mini App apart', async () => {
    await turnOn(['field_book', 'trade_licenses'], []);
    const dashboard = await call('GET', '/sector/field_book/records', admin());
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data).toMatchObject({ total: 0, canManage: true });
    expect((dashboard.body.data.kinds as Array<{ kind: string }>).map((k) => k.kind)).toEqual([
      'treatment',
      'fertilization',
      'harvest',
    ]);
    const miniApp = await call('GET', '/miniapp/sector/field_book/records', farmer());
    expect(miniApp.status).toBe(403);
    expect(miniApp.body.error?.message).toContain('Mini App');

    await turnOn(['trade_licenses'], ['field_book']);
    expect((await call('GET', '/sector/field_book/records', farmer())).status).toBe(403);
    expect((await call('GET', '/miniapp/sector/field_book/records', farmer())).status).toBe(200);
    await turnOn(['field_book', 'trade_licenses'], ['field_book', 'trade_licenses']);
  });

  it('validates the declared fields', async () => {
    const missing = await call('POST', '/sector/field_book/records', farmer(), {
      kind: 'treatment',
      data: { date: '2026-11-20', plot: 'Vigna', crop: 'Vite' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error?.message).toContain('Prodotto commerciale');
    const badDate = await call(
      'POST',
      '/sector/field_book/records',
      farmer(),
      treatment({ date: '2026-02-30' }),
    );
    expect(badDate.status).toBe(400);
    const unknownField = await call(
      'POST',
      '/sector/field_book/records',
      farmer(),
      treatment({ secret: 'x' }),
    );
    expect(unknownField.status).toBe(400);
    const unknownKind = await call('POST', '/sector/field_book/records', farmer(), {
      kind: 'party',
      data: {},
    });
    expect(unknownKind.status).toBe(400);
  });

  it('lets members write and see only their own entries, staff the whole register', async () => {
    const mine = await call('POST', '/miniapp/sector/field_book/records', farmer(), treatment());
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({
      kind: 'treatment',
      kindLabel: 'Trattamento fitosanitario',
      title: `Rame ${run} · Vite`,
      occurredOn: '2026-11-20',
      mine: true,
    });
    const adminEntry = await call(
      'POST',
      '/sector/field_book/records',
      admin(),
      treatment({ product: `Zolfo ${run}`, date: '2026-11-21' }),
    );
    expect(adminEntry.status).toBe(201);
    const adminId = adminEntry.body.data.id as string;

    const farmerList = await call('GET', '/sector/field_book/records', farmer());
    expect(farmerList.body.data.total).toBe(1);
    const otherList = await call('GET', '/sector/field_book/records', as('other', 'MEMBER'));
    expect(otherList.body.data.total).toBe(0);
    const staffList = await call('GET', '/sector/field_book/records', as('operator', 'OPERATOR'));
    expect(staffList.body.data.total).toBe(2);
    // Newest event first.
    expect((staffList.body.data.items as Array<{ id: string }>)[0].id).toBe(adminId);

    expect((await call('GET', `/sector/field_book/records/${adminId}`, farmer())).status).toBe(404);
    expect((await call('DELETE', `/sector/field_book/records/${adminId}`, farmer())).status).toBe(
      404,
    );
    const search = await call('GET', `/sector/field_book/records?search=zolfo`, admin());
    expect(search.body.data.total).toBe(1);
    const range = await call(
      'GET',
      '/sector/field_book/records?from=2026-11-21&to=2026-11-30',
      admin(),
    );
    expect(range.body.data.total).toBe(1);

    const audit = await prisma.auditLog.findMany({
      where: { tenantId: orgId, eventType: 'SECTOR_RECORD_CREATED' },
    });
    expect(audit.map((a) => (a.payload as { channel: string }).channel).sort()).toEqual([
      'dashboard',
      'miniapp',
    ]);
  });

  it('follows the custom role of the person', async () => {
    const role = await prisma.orgRole.create({
      data: {
        orgId,
        name: `Solo pratiche ${run}`,
        baseRole: 'OPERATOR',
        permissions: ['practice.read:tenant', 'field_book.read:tenant'],
      },
    });
    await prisma.membership.updateMany({
      where: { orgId, userId: people.operator },
      data: { customRoleId: role.id },
    });
    const operator = as('operator', 'OPERATOR');
    const list = await call('GET', '/sector/field_book/records', operator);
    expect(list.status).toBe(200);
    expect(list.body.data.canManage).toBe(false);
    expect((await call('GET', '/sector/trade_licenses/records', operator)).status).toBe(403);
    expect((await call('POST', '/sector/field_book/records', operator, treatment())).status).toBe(
      403,
    );
    await prisma.membership.updateMany({
      where: { orgId, userId: people.operator },
      data: { customRoleId: null },
    });
  });

  it('keeps the deadline of an expiry in step with the entry', async () => {
    const created = await call('POST', '/sector/trade_licenses/records', admin(), {
      kind: 'license',
      data: {
        holder: `Mario ${run}`,
        licenseType: 'plant_protection',
        issuedOn: '2021-12-01',
        expiresOn: '2026-12-01',
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data.dueDate).toBe('2026-12-01');
    const deadline = () => prisma.complianceDeadline.findUnique({ where: { sectorRecordId: id } });
    expect(await deadline()).toMatchObject({
      category: 'PATENTINO',
      title: `Abilitazioni e patentini: Patentino prodotti fitosanitari · Mario ${run}`,
      status: 'OPEN',
    });

    // Closed by someone, then renewed: open again on the new date.
    const first = (await deadline())!;
    await prisma.complianceDeadline.update({
      where: { id: first.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const renewed = await call('PATCH', `/sector/trade_licenses/records/${id}`, admin(), {
      data: {
        holder: `Mario ${run}`,
        licenseType: 'plant_protection',
        issuedOn: '2026-11-30',
        expiresOn: '2031-11-30',
      },
    });
    expect(renewed.status).toBe(200);
    const moved = (await deadline())!;
    expect(moved.id).toBe(first.id);
    expect(moved.status).toBe('OPEN');
    expect(moved.dueDate.toISOString().slice(0, 10)).toBe('2031-11-30');

    // No expiry any more: no deadline.
    await call('PATCH', `/sector/trade_licenses/records/${id}`, admin(), {
      data: { holder: `Mario ${run}`, licenseType: 'tractor' },
    });
    expect(await deadline()).toBeNull();

    // An entry deleted takes its deadline with it.
    await call('PATCH', `/sector/trade_licenses/records/${id}`, admin(), {
      data: { holder: `Mario ${run}`, licenseType: 'tractor', expiresOn: '2027-01-15' },
    });
    expect(await deadline()).not.toBeNull();
    expect((await call('DELETE', `/sector/trade_licenses/records/${id}`, admin())).status).toBe(
      200,
    );
    expect(await deadline()).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { tenantId: orgId, eventType: 'SECTOR_RECORD_DELETED' },
      }),
    ).toBe(1);
  });

  it('never reaches an entry of another organization of the same sector', async () => {
    const entry = await call('POST', '/sector/field_book/records', admin(), treatment());
    const id = entry.body.data.id as string;
    const otherOrg = (
      await new TenantRepository(prisma).createTenant({ name: `Altra ${run}`, module: 'agri' })
    ).id;
    {
      await prisma.tenant.update({
        where: { id: otherOrg },
        data: { enabledFeatures: ['field_book'], miniAppFeatures: ['field_book'] },
      });
      people.stranger = (
        await new UserRepository(prisma).createUser(otherOrg, {
          email: `stranger-${run}@sector.local`,
          role: 'ADMIN',
        })
      ).id;
      const headers = authHeaders(otherOrg, people.stranger, 'ADMIN');
      for (const prefix of ['/sector', '/miniapp/sector']) {
        const url = `${prefix}/field_book/records/${id}`;
        expect((await call('GET', url, headers)).status).toBe(404);
        expect((await call('PATCH', url, headers, { data: treatment().data })).status).toBe(404);
        expect((await call('DELETE', url, headers)).status).toBe(404);
        const list = await call('GET', `${prefix}/field_book/records`, headers);
        expect(list.body.data.total).toBe(0);
      }
      expect(await prisma.sectorRecord.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  describe('files of an entry', () => {
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const upload = (url: string, headers: Record<string, string>, name: string, content: Buffer) =>
      call('POST', url, headers, {
        fileName: name,
        mimeType: 'application/pdf',
        contentBase64: content.toString('base64'),
      });
    let licence = '';

    beforeAll(async () => {
      const created = await call('POST', '/sector/trade_licenses/records', admin(), {
        kind: 'license',
        data: { holder: `Anna ${run}`, licenseType: 'plant_protection', expiresOn: '2030-05-01' },
      });
      licence = created.body.data.id as string;
    });

    it('takes PDFs and photos, recognized from the content, and gives them back', async () => {
      const before = filesOnDisk();
      const added = await upload(
        `/sector/trade_licenses/records/${licence}/attachments`,
        admin(),
        'attestato.pdf',
        PDF,
      );
      expect(added.status).toBe(201);
      const files = added.body.data.attachments as Array<{ id: string; mimeType: string }>;
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ mimeType: 'application/pdf', fileName: 'attestato.pdf' });
      expect(filesOnDisk()).toBe(before + 1);

      // A photo from the Mini App, whatever name it has.
      const photo = await upload(
        `/miniapp/sector/trade_licenses/records/${licence}/attachments`,
        admin(),
        'foto.pdf',
        PNG,
      );
      expect(photo.status).toBe(201);
      expect(
        (photo.body.data.attachments as Array<{ mimeType: string }>).map((f) => f.mimeType),
      ).toEqual(['application/pdf', 'image/png']);

      const download = await app.inject({
        method: 'GET',
        url: `/sector/trade_licenses/records/${licence}/attachments/${files[0].id}/download`,
        headers: admin(),
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
      expect(download.headers['content-disposition']).toContain('attachment;');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.rawPayload.equals(PDF)).toBe(true);
    });

    it('refuses other formats, empty files, and members on entries not theirs', async () => {
      const url = `/sector/trade_licenses/records/${licence}/attachments`;
      const exe = await upload(
        url,
        admin(),
        'virus.pdf',
        Buffer.from('MZ\u0090\u0000\u0003binary'),
      );
      expect(exe.status).toBe(400);
      expect(exe.body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      const text = await upload(url, admin(), 'nota.txt', Buffer.from('solo testo'));
      expect(text.status).toBe(400);
      expect((await upload(url, farmer(), 'a.pdf', PDF)).status).toBe(404);
    });

    it('removes a file, and the files of a deleted entry, from the storage too', async () => {
      const entry = await call('GET', `/sector/trade_licenses/records/${licence}`, admin());
      const files = entry.body.data.attachments as Array<{ id: string }>;
      const before = filesOnDisk();
      const removed = await call(
        'DELETE',
        `/sector/trade_licenses/records/${licence}/attachments/${files[0].id}`,
        admin(),
      );
      expect(removed.status).toBe(200);
      expect(removed.body.data.attachments).toHaveLength(1);
      expect(filesOnDisk()).toBe(before - 1);

      expect(
        (await call('DELETE', `/sector/trade_licenses/records/${licence}`, admin())).status,
      ).toBe(200);
      expect(filesOnDisk()).toBe(before - 2);
      expect(await prisma.sectorRecordAttachment.count({ where: { recordId: licence } })).toBe(0);
      const audit = await prisma.auditLog.findMany({
        where: { tenantId: orgId, eventType: { startsWith: 'SECTOR_RECORD_FILE' } },
      });
      expect(audit.map((a) => a.eventType).sort()).toEqual([
        'SECTOR_RECORD_FILE_ADDED',
        'SECTOR_RECORD_FILE_ADDED',
        'SECTOR_RECORD_FILE_REMOVED',
      ]);
    });
  });

  describe('export of the register', () => {
    it('gives CSV, Excel and PDF with the filters of the page', async () => {
      await call(
        'POST',
        '/sector/field_book/records',
        admin(),
        treatment({ product: `=HYPERLINK("x") ${run}`, date: '2026-10-05' }),
      );
      await call('POST', '/sector/field_book/records', admin(), {
        kind: 'harvest',
        data: { date: '2026-10-06', plot: 'Vigna nord', crop: `Uva ${run}` },
      });
      const get = (query: string, headers = admin()) =>
        app.inject({
          method: 'GET',
          url: `/sector/field_book/records/export?${query}`,
          headers,
        });

      const csv = await get('format=csv&from=2026-10-01&to=2026-10-31');
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      const text = csv.body;
      expect(text.startsWith('﻿"Data";"Tipo";"Voce";"Appezzamento";"Coltura"')).toBe(true);
      expect(text).toContain('"05/10/2026";"Trattamento fitosanitario"');
      expect(text).toContain(`"06/10/2026";"Raccolta";"Uva ${run} · Vigna nord"`);
      // Never a formula in a spreadsheet.
      expect(text).toContain(`"'=HYPERLINK(""x"") ${run}`);
      expect(text.trim().split('\r\n')).toHaveLength(3);

      const xlsx = await get('format=xlsx&kind=harvest');
      expect(xlsx.statusCode).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
      const sheet = book.worksheets[0];
      expect(sheet.getRow(1).getCell(2).value).toBe('Tipo');
      expect(sheet.getColumn(2).values.slice(2)).toEqual(['Raccolta']);

      const pdf = await get('format=pdf');
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.headers['content-disposition']).toMatch(/quaderno-di-campagna.*\.pdf/);

      // A member exports only their own entries.
      const own = await get('format=csv', farmer());
      expect(own.statusCode).toBe(200);
      expect(own.body).not.toContain(`Uva ${run}`);

      const exported = await prisma.auditLog.findMany({
        where: { tenantId: orgId, eventType: 'SECTOR_RECORDS_EXPORTED' },
      });
      expect(exported.map((a) => (a.payload as { format: string }).format).sort()).toEqual([
        'csv',
        'csv',
        'pdf',
        'xlsx',
      ]);
    });

    it('is refused when the exports of the organization are off', async () => {
      await prisma.tenant.update({ where: { id: orgId }, data: { disabledFeatures: ['exports'] } });
      const off = await app.inject({
        method: 'GET',
        url: '/sector/field_book/records/export?format=csv',
        headers: admin(),
      });
      expect(off.statusCode).toBe(403);
      await prisma.tenant.update({ where: { id: orgId }, data: { disabledFeatures: [] } });
    });
  });

  it('lists only the built functions of its sector among the permissions of custom roles', async () => {
    const catalog = await call('GET', '/roles/catalog', admin());
    const operator = Object.keys(catalog.body.data.OPERATOR as object);
    expect(operator).toEqual(
      expect.arrayContaining([
        'field_book.read',
        'field_book.manage',
        'trade_licenses.read',
        'trade_licenses.manage',
        'practice.read',
      ]),
    );
    for (const hidden of ['cap_file.read', 'grants.read', 'waste_records.manage']) {
      expect(operator).not.toContain(hidden);
    }
  });
});
