/**
 * The usage events of a period as a CSV file: one organization's (with who did the work through a
 * delegation) and the platform's (every organization, with the internal cost). Reversals appear as
 * negative rows; events of other periods or organizations never.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordUsage, reverseUsageEvent, usageExport } from '../src/core/usage/usage.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

/** Rows of the CSV without the BOM, split on the commas outside quotes. */
function parse(csv: string): string[][] {
  expect(csv.startsWith('﻿')).toBe(true);
  return csv
    .slice(1)
    .trimEnd()
    .split('\r\n')
    .map((line) => (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, '')))
    .map((cells) => cells.filter((_, i) => i < cells.length - 1 || cells[i] !== ''))
    .map((cells) => cells.map((c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c)));
}

describe.runIf(Boolean(DATABASE_URL))('usage export as CSV', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  const org = { company: '', network: '' };
  let adminId = '';
  // A fixed month in the past: only this test's events fall in the platform file filter below.
  const now = new Date('2026-07-20T10:00:00Z');
  const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 6, day, hour));

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    org.company = (await tenants.createTenant({ name: `Azienda "Collio" ${run}` })).id;
    org.network = (await tenants.createTenant({ name: `Rete ${run}` })).id;
    adminId = (
      await new UserRepository(prisma).createUser(org.company, {
        email: `admin-${run}@usage.local`,
        role: 'ADMIN',
      })
    ).id;
    await recordUsage(prisma, [
      { key: `${run}:doc`, tenantId: org.company, kind: 'DOCUMENT_RECEIVED', occurredAt: at(3) },
      {
        key: `${run}:ocr`,
        tenantId: org.company,
        kind: 'OCR_PAGES',
        quantity: 4,
        actorOrgId: org.network,
        occurredAt: at(5, 21),
      },
      // Another month: never in July's file.
      {
        key: `${run}:old`,
        tenantId: org.company,
        kind: 'AI_CALL',
        occurredAt: new Date('2026-06-30T10:00:00Z'),
      },
    ]);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("exports one organization's events of the period, one row each", async () => {
    const file = await usageExport(prisma, {
      tenantId: org.company,
      kind: 'month',
      previous: false,
      now,
    });
    expect(file.fileName).toBe('consumi_2026-07-01_2026-07-31.csv');
    expect(file.title).toBe('Consumi dal 01/07/2026 al 31/07/2026');
    const rows = parse(file.csv);
    expect(rows[0]).toEqual([
      'Data',
      'Fatto da',
      'Tipo',
      'Quantità',
      'Unità',
      'Rettifica',
      'Motivo',
      'Codice evento',
    ]);
    const body = rows.slice(1).map((r) => r.slice(0, 5));
    expect(body[0]).toEqual([
      '2026-07-03 12:00',
      'la tua organizzazione',
      'Documenti ricevuti',
      '1',
      'document',
    ]);
    // 21:00 UTC is 23:00 in Italy, still the 5th.
    expect(body[1]).toEqual([
      '2026-07-05 23:00',
      `Rete ${run}`,
      'Pagine lette con OCR',
      '4',
      'page',
    ]);
    expect(body).toHaveLength(file.rows);
    expect(file.truncated).toBe(false);
  });

  it('lists a reversal as a negative row, with its reason', async () => {
    await recordUsage(prisma, [
      { key: `${run}:now`, tenantId: org.company, kind: 'AI_CALL', quantity: 3 },
    ]);
    const event = await prisma.usageEvent.findUniqueOrThrow({
      where: { idempotencyKey: `${run}:now` },
    });
    await reverseUsageEvent(
      prisma,
      { eventId: event.id, reason: 'Contate due volte', actorUserId: adminId },
      () => Promise.resolve(),
    );
    const rows = parse(
      (await usageExport(prisma, { tenantId: org.company, kind: 'month', previous: false })).csv,
    ).slice(1);
    expect(rows.map((r) => [r[2], r[3], r[5], r[6]])).toEqual([
      ["Richieste all'assistente", '3', '', ''],
      ["Richieste all'assistente", '-3', `rettifica di ${event.id}`, 'Contate due volte'],
    ]);
  });

  it('exports every organization for the platform, with the internal cost', async () => {
    const file = await usageExport(prisma, {
      tenantId: null,
      kind: 'month',
      previous: false,
      rates: { OCR_PAGES: 0.01 },
      now,
    });
    expect(file.fileName).toBe('consumi-piattaforma_2026-07-01_2026-07-31.csv');
    const rows = parse(file.csv);
    expect(rows[0].slice(0, 8)).toEqual([
      'Data',
      'Organizzazione',
      'Fatto da',
      'Tipo',
      'Quantità',
      'Unità',
      'Costo interno (€)',
      'Rettifica',
    ]);
    const ocr = rows.find((r) => r[1] === `Azienda "Collio" ${run}` && r[4] === '4');
    expect(ocr?.slice(2, 7)).toEqual([`Rete ${run}`, 'Pagine lette con OCR', '4', 'page', '0.04']);
    const doc = rows.find(
      (r) => r[1] === `Azienda "Collio" ${run}` && r[3] === 'Documenti ricevuti',
    );
    expect(doc?.[2]).toBe(`Azienda "Collio" ${run}`);
    expect(doc?.[6]).toBe('');
    expect(rows.some((r) => r[3] === "Richieste all'assistente" && r[1].endsWith(run))).toBe(false);
  });
});
