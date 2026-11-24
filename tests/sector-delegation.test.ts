/**
 * Registers of the sector functions through a delegation (MF8, D3): a delegation names the
 * registers it covers besides the practices; the delegated person works on them as the grantor's
 * staff would, only for the delegated operations, never sees the grantor's people, and every use
 * goes in the grantor's log.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { registersOf } from '../src/core/delegation/delegation.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('registers in the scope of a delegation', () => {
  it('reads only the sector registers, without the practices', () => {
    expect(registersOf({ types: ['practices', 'sector:field_book', 'sector:farm_fuel'] })).toEqual([
      'field_book',
      'farm_fuel',
    ]);
    expect(registersOf({ types: ['practices'] })).toEqual([]);
    expect(registersOf(null)).toEqual([]);
  });
});

type Json = { data: Record<string, unknown> & { id?: string }; error?: { code: string } };

describe.runIf(Boolean(DATABASE_URL))('sector registers through a delegation', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org = { farm: '', studio: '' };
  const people = { farmAdmin: '', consultant: '' };
  let grantId = '';
  let practicesOnly = '';

  const farmAdmin = () => authHeaders(org.farm, people.farmAdmin, 'ADMIN');
  const consultant = () => authHeaders(org.studio, people.consultant, 'ADMIN');
  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => {
    const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    return {
      status: res.statusCode,
      body: res.headers['content-type']?.includes('json') ? res.json<Json>() : null,
    };
  };
  const isoDay = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const records = (grant: string, feature = 'field_book') =>
    `/grants/${grant}/sector/${feature}/records`;
  const harvest = { date: '2026-10-14', plot: 'Braida', crop: 'Mais', quantity: 68, unit: 't' };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.farm = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    org.studio = (await tenants.createTenant({ name: `Studio ${run}`, module: 'generic' })).id;
    await prisma.tenant.update({
      where: { id: org.farm },
      data: { enabledFeatures: ['field_book', 'trade_licenses'] },
    });
    people.farmAdmin = (
      await users.createUser(org.farm, { email: `farm-${run}@deleg.local`, role: 'ADMIN' })
    ).id;
    people.consultant = (
      await users.createUser(org.studio, { email: `studio-${run}@deleg.local`, role: 'ADMIN' })
    ).id;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3021',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-sector-delegation',
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
      interpreterService: new InterpreterService(llm),
      executorService: new ExecutorService({ practiceService: practices }),
      contextService: new ContextService(practices),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
    await app.ready();

    const issued = await call('POST', '/grants', farmAdmin(), {
      grantee: { email: `studio-${run}@deleg.local` },
      operations: ['READ', 'CREATE', 'UPDATE'],
      validUntil: isoDay(90),
      registers: ['field_book'],
    });
    expect(issued.status).toBe(201);
    grantId = issued.body!.data.id!;
    const plain = await call('POST', '/grants', farmAdmin(), {
      grantee: { email: `studio-${run}@deleg.local` },
      operations: ['READ'],
      validUntil: isoDay(30),
    });
    practicesOnly = plain.body!.data.id!;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('names the registers on both sides of the delegation', async () => {
    const issued = await call('GET', '/grants/issued', farmAdmin());
    const mine = (issued.body!.data as unknown as Array<{ id: string; registers: unknown }>).find(
      (g) => g.id === grantId,
    );
    expect(mine?.registers).toEqual([{ id: 'field_book', label: 'Quaderno di campagna' }]);
    const received = await call('GET', '/grants/received', consultant());
    const theirs = (
      received.body!.data as unknown as Array<{ id: string; registers: unknown }>
    ).find((g) => g.id === grantId);
    expect(theirs?.registers).toEqual([{ id: 'field_book', label: 'Quaderno di campagna' }]);
  });

  it('refuses a register outside the sector of the grantor', async () => {
    const wrong = await call('POST', '/grants', farmAdmin(), {
      grantee: { email: `studio-${run}@deleg.local` },
      operations: ['READ'],
      validUntil: isoDay(30),
      registers: ['grants'],
    });
    expect(wrong.status).toBe(400);
  });

  it('lets the delegated person read and write the register, never seeing its people', async () => {
    const created = await call('POST', records(grantId), consultant(), {
      kind: 'harvest',
      data: harvest,
    });
    expect(created.status).toBe(201);
    const entryId = created.body!.data.id!;

    const list = await call('GET', records(grantId), consultant());
    expect(list.status).toBe(200);
    expect(list.body!.data.people).toEqual([]);
    expect(list.body!.data.delegation).toMatchObject({ grantorName: `Azienda ${run}` });
    expect((list.body!.data.items as Array<{ id: string }>).map((i) => i.id)).toContain(entryId);

    const updated = await call('PATCH', `${records(grantId)}/${entryId}`, consultant(), {
      data: { ...harvest, quantity: 70 },
    });
    expect(updated.status).toBe(200);
    // The grantor sees the entry in its own register.
    const own = await call('GET', '/sector/field_book/records', farmAdmin());
    expect((own.body!.data.items as Array<{ id: string }>).map((i) => i.id)).toContain(entryId);

    const log = await prisma.auditLog.findMany({
      where: { tenantId: org.farm, eventType: 'DELEGATED_ACCESS' },
      select: { payload: true },
    });
    expect(log.map((l) => (l.payload as { action?: string }).action)).toEqual(
      expect.arrayContaining(['create', 'list', 'update']),
    );
  });

  it('keeps to the registers and operations of the delegation', async () => {
    const other = await call('GET', records(grantId, 'trade_licenses'), consultant());
    expect(other.status).toBe(403);
    expect(other.body!.error?.code).toBe('REGISTER_NOT_DELEGATED');

    const notCovered = await call('GET', records(practicesOnly), consultant());
    expect(notCovered.status).toBe(403);
    expect(notCovered.body!.error?.code).toBe('REGISTER_NOT_DELEGATED');

    const exported = await call('GET', `${records(grantId)}/export?format=csv`, consultant());
    expect(exported.status).toBe(403);
    expect(exported.body!.error?.code).toBe('OPERATION_NOT_DELEGATED');

    // Nobody of the grantor can be named through a delegation, even where entries name one.
    const licences = await call('POST', '/grants', farmAdmin(), {
      grantee: { email: `studio-${run}@deleg.local` },
      operations: ['READ', 'CREATE'],
      validUntil: isoDay(30),
      registers: ['trade_licenses'],
    });
    const licence = {
      holder: 'Marco T.',
      licenseType: 'plant_protection',
      expiresOn: isoDay(200),
    };
    const named = await call(
      'POST',
      records(licences.body!.data.id!, 'trade_licenses'),
      consultant(),
      { kind: 'license', data: { ...licence, notify: people.farmAdmin } },
    );
    expect(named.status).toBe(403);
    const plain = await call(
      'POST',
      records(licences.body!.data.id!, 'trade_licenses'),
      consultant(),
      { kind: 'license', data: licence },
    );
    expect(plain.status).toBe(201);

    // Someone else, or the same person after the revocation, gets nothing.
    expect((await call('GET', records(grantId), farmAdmin())).status).toBe(404);
    await call('POST', `/grants/${grantId}/revoke`, farmAdmin(), {});
    expect((await call('GET', records(grantId), consultant())).status).toBe(404);
  });
});
