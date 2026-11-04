/**
 * MF9 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §1.2-§1.3, decision D4): a network invites
 * companies, the companies confirm; the network sees their minimal profile and aggregate
 * statistics protected by the D4 rules, and never their data.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import {
  periodBounds,
  protectAmount,
  protectCompanies,
} from '../src/core/network/network-stats.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { Protected } from '../src/core/network/network-stats.service.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('D4 protection rules', () => {
  it('shows an amount only from at least 5 companies, and small company counts as «meno di 3»', () => {
    expect(protectAmount(40, 5)).toBe(40);
    expect(protectAmount(40, 4)).toBeNull();
    expect(protectAmount(0, 0)).toBe(0);
    expect(protectCompanies(0)).toBe(0);
    expect(protectCompanies(1)).toBe('lt3');
    expect(protectCompanies(2)).toBe('lt3');
    expect(protectCompanies(3)).toBe(3);
  });

  it('uses fixed calendar periods only', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const iso = (b: { from: Date; to: Date }) =>
      [b.from, b.to].map((d) => d.toISOString().slice(0, 10));
    expect(iso(periodBounds('month', false, now))).toEqual(['2026-11-01', '2026-12-01']);
    expect(iso(periodBounds('month', true, now))).toEqual(['2026-10-01', '2026-11-01']);
    expect(iso(periodBounds('quarter', false, now))).toEqual(['2026-10-01', '2027-01-01']);
    expect(iso(periodBounds('year', true, now))).toEqual(['2025-01-01', '2026-01-01']);
  });
});

describe.runIf(Boolean(DATABASE_URL))('networks and memberships with PostgreSQL (MF9)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let networkId: string;
  const networkPeople: Record<'admin' | 'operator', string> = { admin: '', operator: '' };
  const companies: Array<{ id: string; admin: string; practiceId: string }> = [];

  const as = (orgId: string, userId: string, role: UserRole = 'ADMIN') =>
    authHeaders(orgId, userId, role);
  const net = (role: 'ADMIN' | 'OPERATOR' = 'ADMIN') =>
    as(networkId, role === 'ADMIN' ? networkPeople.admin : networkPeople.operator, role);
  const company = (i: number) => as(companies[i].id, companies[i].admin);
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: object, payload?: object) =>
    app.inject({
      method,
      url,
      headers: headers as Record<string, string>,
      ...(payload ? { payload } : {}),
    });

  type Stats = {
    members: { inPeriod: number; activeNow: number; sufficient: boolean };
    practicesByStatus: Array<{ status: string; value: Protected }>;
    practicesByKind: Array<{ kind: string; value: Protected }>;
    deadlines: Array<{ category: string; overdue: Protected; dueSoon: Protected }>;
    organic: { valid: Protected; total: number | null };
  };
  const stats = async () => {
    const res = await call('GET', '/network/stats?period=month', net('OPERATOR'));
    expect(res.statusCode).toBe(200);
    return res.json<{ data: Stats }>().data;
  };

  /** The network invites company i and the company confirms. */
  const join = async (i: number) => {
    const invited = await call('POST', '/network/members', net(), { orgId: companies[i].id });
    expect(invited.statusCode).toBe(201);
    const { relationId } = invited.json<{ data: { relationId: string } }>().data;
    expect((await call('POST', `/memberships/${relationId}/confirm`, company(i))).statusCode).toBe(
      200,
    );
    return relationId;
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    networkId = (await tenants.createTenant({ name: `Rete agricola ${run}` })).id;
    await prisma.tenant.update({ where: { id: networkId }, data: { type: 'NETWORK' } });
    networkPeople.admin = (
      await users.createUser(networkId, { email: `rete-admin-${run}@mf9.local`, role: 'ADMIN' })
    ).id;
    networkPeople.operator = (
      await users.createUser(networkId, { email: `rete-op-${run}@mf9.local`, role: 'OPERATOR' })
    ).id;
    const today = new Date();
    const day = (offset: number) =>
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
    for (let i = 0; i < 6; i++) {
      const id = (await tenants.createTenant({ name: `Azienda ${i} ${run}` })).id;
      const admin = (
        await users.createUser(id, { email: `azienda${i}-${run}@mf9.local`, role: 'ADMIN' })
      ).id;
      const practice = await prisma.practice.create({
        data: {
          tenantId: id,
          userId: admin,
          payload: { schemaVersion: 2, name: `Segreto ${i} ${run}`, kind: 'generic' },
        },
      });
      // Only two companies have a practice of this type: its count must stay hidden.
      if (i < 2) {
        await prisma.practice.create({
          data: {
            tenantId: id,
            userId: admin,
            payload: { schemaVersion: 2, name: `Vigna ${i}`, kind: 'agri' },
          },
        });
      }
      // Two companies with an overdue DURC; five with a valid organic certification.
      if (i < 2) {
        await prisma.complianceDeadline.create({
          data: { tenantId: id, category: 'DURC', title: 'DURC', dueDate: day(-3) },
        });
      }
      if (i < 5) {
        await prisma.complianceDeadline.create({
          data: { tenantId: id, category: 'CERTIFICAZIONE_BIO', title: 'BIO', dueDate: day(200) },
        });
      }
      companies.push({ id, admin, practiceId: practice.id });
    }
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3013',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-mf9',
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
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('lets a company set its minimal profile', async () => {
    const res = await call('PATCH', '/organization', company(0), {
      municipality: '  Cormons ',
      sector: 'Viticoltura',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { municipality: string; sector: string } }>().data).toMatchObject({
      municipality: 'Cormons',
      sector: 'Viticoltura',
    });
  });

  it('is a function of networks only', async () => {
    expect((await call('GET', '/network/members', company(0))).statusCode).toBe(403);
    expect((await call('GET', '/network/stats', company(0))).statusCode).toBe(403);
  });

  it('invites by membership code; the company confirms, refuses or is asked again', async () => {
    const first = await call('POST', '/network/members', net(), { orgId: companies[0].id });
    expect(first.statusCode).toBe(201);
    const { relationId } = first.json<{ data: { relationId: string } }>().data;
    expect(
      (await call('POST', '/network/members', net(), { orgId: companies[0].id })).statusCode,
    ).toBe(409);
    // Only the invited company answers, and only an administrator of the network invites (roles:
    // tests/authz.matrix.test.ts).
    expect((await call('POST', `/memberships/${relationId}/confirm`, company(1))).statusCode).toBe(
      404,
    );
    expect(
      (await call('POST', '/network/members', net('OPERATOR'), { orgId: companies[1].id }))
        .statusCode,
    ).toBe(403);

    const mine = await call('GET', '/memberships', company(0));
    expect(mine.json<{ data: Array<{ name: string; status: string }> }>().data).toEqual([
      expect.objectContaining({ name: `Rete agricola ${run}`, status: 'PENDING' }),
    ]);
    expect((await call('POST', `/memberships/${relationId}/refuse`, company(0))).statusCode).toBe(
      200,
    );
    expect((await call('POST', `/memberships/${relationId}/confirm`, company(0))).statusCode).toBe(
      409,
    );
    // Refused: the network can ask again.
    const again = await call('POST', '/network/members', net(), { orgId: companies[0].id });
    expect(again.statusCode).toBe(201);
    const id = again.json<{ data: { relationId: string } }>().data.relationId;
    expect((await call('POST', `/memberships/${id}/confirm`, company(0))).statusCode).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: companies[0].id, eventType: 'NETWORK_MEMBERSHIP_CONFIRMED' },
      }),
    ).toBe(1);
  });

  it('shows the network the minimal profile of its members and none of their data', async () => {
    const res = await call('GET', '/network/members', net());
    const members = res.json<{ data: Array<Record<string, unknown>> }>().data;
    expect(members).toEqual([
      expect.objectContaining({
        orgId: companies[0].id,
        name: `Azienda 0 ${run}`,
        municipality: 'Cormons',
        sector: 'Viticoltura',
        status: 'ACTIVE',
      }),
    ]);
    expect(res.body).not.toContain('Segreto');
    // A membership gives no permission on the data of the company.
    const practice = await call('GET', `/practices/${companies[0].practiceId}`, net());
    expect(practice.statusCode).toBe(404);
  });

  it('hides every aggregate below 5 companies', async () => {
    for (const i of [1, 2, 3]) await join(i);
    const s = await stats();
    expect(s.members).toMatchObject({ inPeriod: 4, activeNow: 4, sufficient: false });
    expect(s.practicesByStatus.every((p) => p.value === null)).toBe(true);
    expect(s.organic.valid).toBeNull();
  });

  it('applies the D4 rules from 5 companies on, and records every consultation', async () => {
    const leaving = await join(4);
    await join(5);
    const s = await stats();
    expect(s.members).toMatchObject({ inPeriod: 6, activeNow: 6, sufficient: true });
    expect(s.practicesByStatus.find((p) => p.status === 'CREATED')?.value).toBe(8);
    // «agri» comes from two companies only.
    expect(s.practicesByKind).toEqual([
      { kind: 'agri', value: null },
      { kind: 'generic', value: 6 },
    ]);
    expect(s.deadlines.find((d) => d.category === 'DURC')).toMatchObject({ overdue: 'lt3' });
    expect(s.organic).toEqual({ valid: 5, total: 6 });
    expect(
      await prisma.auditLog.count({
        where: { tenantId: networkId, eventType: 'NETWORK_STATS_VIEWED' },
      }),
    ).toBeGreaterThanOrEqual(2);

    // A company that leaves still counts for this period, not among the members today.
    expect((await call('POST', `/memberships/${leaving}/leave`, company(4))).statusCode).toBe(200);
    const after = await stats();
    expect(after.members).toMatchObject({ inPeriod: 6, activeNow: 5 });
  });

  it('lets the network end a membership', async () => {
    const members = (await call('GET', '/network/members', net())).json<{
      data: Array<{ relationId: string; orgId: string }>;
    }>().data;
    const target = members.find((m) => m.orgId === companies[5].id)!;
    expect(
      (await call('POST', `/network/members/${target.relationId}/end`, net())).statusCode,
    ).toBe(200);
    const mine = (await call('GET', '/memberships', company(5))).json<{ data: unknown[] }>().data;
    expect(mine).toEqual([]);
  });
});
