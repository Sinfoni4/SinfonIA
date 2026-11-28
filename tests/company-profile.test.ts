/**
 * Fase 1C: the company profile. Its administrators write it, every save is a new version never
 * changed afterwards; a required answer missing makes it «incompleto», never refused; a delegate
 * reads it, writes a version marked as theirs and checks it, only through a delegation that covers
 * the profile; the company never checks itself; the console sees only the activities.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { coversProfile } from '../src/core/delegation/delegation.service.js';
import {
  missingAnswers,
  validateProfile,
} from '../src/core/organization/company-profile.service.js';
import { getOrganization } from '../src/core/platform/platform.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { AGRI_PROFILE } from '../src/modules/registry.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('questionnaire of the company profile', () => {
  it('keeps only the activities declared, in the order of the questionnaire', () => {
    const profile = validateProfile(AGRI_PROFILE, {
      activities: ['brewery', 'crops', 'crops'],
      data: { common: { units: 'Udine' }, activities: { crops: { area: 12.5 } } },
    });
    expect(profile.activities).toEqual(['crops', 'brewery']);
    expect(profile.data).toEqual({
      common: { units: 'Udine' },
      activities: { crops: { area: 12.5 } },
    });
  });

  it('refuses unknown activities, details of an activity not declared and wrong values', () => {
    expect(() => validateProfile(AGRI_PROFILE, { activities: ['mining'], data: {} })).toThrow(
      'Attività sconosciuta',
    );
    expect(() =>
      validateProfile(AGRI_PROFILE, {
        activities: ['crops'],
        data: { activities: { brewery: { regime: 'craft' } } },
      }),
    ).toThrow('non indicata');
    expect(() =>
      validateProfile(AGRI_PROFILE, {
        activities: ['crops'],
        data: { activities: { crops: { area: -1 } } },
      }),
    ).toThrow('Superficie coltivata');
    expect(() =>
      validateProfile(AGRI_PROFILE, { activities: ['crops'], data: { common: { x: 1 } } }),
    ).toThrow();
  });

  it('says what is missing, never refusing an incomplete profile', () => {
    expect(missingAnswers(AGRI_PROFILE, null)).toEqual(['Attività dell’azienda']);
    const partial = validateProfile(AGRI_PROFILE, { activities: ['crops', 'brewery'], data: {} });
    expect(missingAnswers(AGRI_PROFILE, partial)).toEqual([
      'Dati generali: Unità produttive e sedi (comune, località)',
      'Coltivazioni e seminativi: Superficie coltivata (ha)',
      'Birrificio: Regime',
    ]);
  });

  it('reads the profile in the scope of a delegation', () => {
    expect(coversProfile({ types: ['practices', 'profile'] })).toBe(true);
    expect(coversProfile({ types: ['practices', 'sector:field_book'] })).toBe(false);
    expect(coversProfile(null)).toBe(false);
  });
});

type Json = { data: Record<string, unknown>; error?: { code: string } };

describe.runIf(Boolean(DATABASE_URL))('company profile with PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org = { farm: '', studio: '', other: '' };
  const people = { admin: '', member: '', consultant: '', stranger: '' };
  let grantId = '';
  let readOnly = '';

  const admin = () => authHeaders(org.farm, people.admin, 'ADMIN');
  const member = () => authHeaders(org.farm, people.member, 'MEMBER');
  const consultant = () => authHeaders(org.studio, people.consultant, 'ADMIN');
  const call = async (
    method: 'GET' | 'POST' | 'PUT',
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
  const first = {
    activities: ['crops', 'vineyard_winery'],
    data: {
      common: { units: `Cormons ${run}`, caa: 'CAA di zona' },
      activities: {
        crops: { area: 18, crops: 'Mais, soia' },
        vineyard_winery: { vineyardArea: 6 },
      },
    },
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.farm = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    org.studio = (await tenants.createTenant({ name: `Studio ${run}`, module: 'generic' })).id;
    org.other = (await tenants.createTenant({ name: `Musica ${run}`, module: 'music' })).id;
    people.admin = (
      await users.createUser(org.farm, { email: `admin-${run}@profile.local`, role: 'ADMIN' })
    ).id;
    people.member = (
      await users.createUser(org.farm, { email: `member-${run}@profile.local`, role: 'MEMBER' })
    ).id;
    people.consultant = (
      await users.createUser(org.studio, { email: `studio-${run}@profile.local`, role: 'ADMIN' })
    ).id;
    people.stranger = (
      await users.createUser(org.other, { email: `music-${run}@profile.local`, role: 'ADMIN' })
    ).id;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3022',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-company-profile',
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

  it('starts empty and incomplete, only for its administrators', async () => {
    const empty = await call('GET', '/organization/profile', admin());
    expect(empty.status).toBe(200);
    expect(empty.body!.data).toMatchObject({
      current: null,
      complete: false,
      missing: ['Attività dell’azienda'],
    });
    expect((await call('GET', '/organization/profile', member())).status).toBe(403);
    // A sector without a questionnaire has no profile.
    const none = await call(
      'GET',
      '/organization/profile',
      authHeaders(org.other, people.stranger, 'ADMIN'),
    );
    expect(none.status).toBe(404);
    expect(none.body!.error?.code).toBe('PROFILE_NOT_AVAILABLE');
  });

  it('saves versions, refusing the same content and a stale version', async () => {
    const saved = await call('PUT', '/organization/profile', admin(), {
      ...first,
      expectedVersion: 0,
    });
    expect(saved.status).toBe(200);
    expect(saved.body!.data).toMatchObject({
      complete: true,
      missing: [],
      current: { version: 1, source: 'ORGANIZATION', author: `admin-${run}@profile.local` },
    });
    const same = await call('PUT', '/organization/profile', admin(), first);
    expect(same.body!.error?.code).toBe('NO_CHANGE');
    const stale = await call('PUT', '/organization/profile', admin(), {
      ...first,
      activities: ['crops'],
      data: { ...first.data, activities: { crops: first.data.activities.crops } },
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);

    const second = await call('PUT', '/organization/profile', admin(), {
      activities: ['crops', 'vineyard_winery', 'brewery'],
      data: first.data,
      expectedVersion: 1,
    });
    // Saved, but incomplete: the brewery's regime is required.
    expect(second.status).toBe(200);
    expect(second.body!.data).toMatchObject({
      complete: false,
      missing: ['Birrificio: Regime'],
      current: { version: 2 },
    });
    const history = await call('GET', '/organization/profile/versions', admin());
    expect(
      (history.body!.data as unknown as Array<{ version: number }>).map((v) => v.version),
    ).toEqual([2, 1]);
  });

  it('lets a delegate read, write and check it only through a delegation covering it', async () => {
    const issued = await call('POST', '/grants', admin(), {
      grantee: { email: `studio-${run}@profile.local` },
      operations: ['READ', 'UPDATE'],
      validUntil: isoDay(60),
      profile: true,
    });
    expect(issued.status).toBe(201);
    grantId = issued.body!.data.id as string;
    const plain = await call('POST', '/grants', admin(), {
      grantee: { email: `studio-${run}@profile.local` },
      operations: ['READ'],
      validUntil: isoDay(30),
    });
    readOnly = plain.body!.data.id as string;

    const received = await call('GET', '/grants/received', consultant());
    expect(
      (received.body!.data as unknown as Array<{ id: string; profile: boolean }>).find(
        (g) => g.id === grantId,
      )?.profile,
    ).toBe(true);

    const notCovered = await call('GET', `/grants/${readOnly}/profile`, consultant());
    expect(notCovered.status).toBe(403);
    expect(notCovered.body!.error?.code).toBe('PROFILE_NOT_DELEGATED');

    const seen = await call('GET', `/grants/${grantId}/profile`, consultant());
    expect(seen.status).toBe(200);
    expect(seen.body!.data).toMatchObject({ current: { version: 2 }, complete: false });

    const needs = await call('POST', `/grants/${grantId}/profile/review`, consultant(), {
      outcome: 'NEEDS_INFO',
    });
    expect(needs.body!.error?.code).toBe('NOTE_REQUIRED');
    await call('POST', `/grants/${grantId}/profile/review`, consultant(), {
      outcome: 'NEEDS_INFO',
      note: 'Manca il regime del birrificio',
    });

    const written = await call('PUT', `/grants/${grantId}/profile`, consultant(), {
      activities: ['crops', 'vineyard_winery', 'brewery'],
      data: {
        ...first.data,
        activities: { ...first.data.activities, brewery: { regime: 'agricultural' } },
      },
      expectedVersion: 2,
    });
    expect(written.status).toBe(200);
    expect(written.body!.data).toMatchObject({
      complete: true,
      current: { version: 3, source: 'DELEGATE' },
      review: null,
    });
    const verified = await call('POST', `/grants/${grantId}/profile/review`, consultant(), {
      outcome: 'VERIFIED',
      expectedVersion: 3,
    });
    expect(verified.body!.data).toMatchObject({
      review: { version: 3, outcome: 'VERIFIED', reviewer: `studio-${run}@profile.local` },
    });

    // The company sees who wrote what and every check.
    const own = await call('GET', '/organization/profile/versions', admin());
    const versions = own.body!.data as unknown as Array<{
      version: number;
      source: string;
      reviews: Array<{ outcome: string }>;
    }>;
    expect(versions.map((v) => [v.version, v.source, v.reviews.map((r) => r.outcome)])).toEqual([
      [3, 'DELEGATE', ['VERIFIED']],
      [2, 'ORGANIZATION', ['NEEDS_INFO']],
      [1, 'ORGANIZATION', []],
    ]);
    const log = await prisma.auditLog.findMany({
      where: { tenantId: org.farm, eventType: 'DELEGATED_ACCESS' },
      select: { payload: true },
    });
    expect(log.map((l) => (l.payload as { action?: string }).action)).toEqual(
      expect.arrayContaining(['profile', 'profile_update', 'profile_review']),
    );
  });

  it('never lets the company check itself, nor a read-only delegation write', async () => {
    // No route for the company: checking exists only through a delegation.
    const self = await call('POST', '/organization/profile/review', admin(), {
      outcome: 'VERIFIED',
    });
    expect([404, 405]).toContain(self.status);
    const readOnlyGrant = await call('POST', '/grants', admin(), {
      grantee: { email: `studio-${run}@profile.local` },
      operations: ['READ'],
      validUntil: isoDay(30),
      profile: true,
    });
    const id = readOnlyGrant.body!.data.id as string;
    expect((await call('GET', `/grants/${id}/profile`, consultant())).status).toBe(200);
    const write = await call('POST', `/grants/${id}/profile/review`, consultant(), {
      outcome: 'VERIFIED',
    });
    expect(write.status).toBe(403);
    expect(write.body!.error?.code).toBe('OPERATION_NOT_DELEGATED');
  });

  it('refuses the profile in a delegation of an organization without one', async () => {
    const res = await call('POST', '/grants', authHeaders(org.other, people.stranger, 'ADMIN'), {
      grantee: { email: `studio-${run}@profile.local` },
      operations: ['READ'],
      validUntil: isoDay(30),
      profile: true,
    });
    expect(res.status).toBe(400);
  });

  it('shows the console only the activities, never the details', async () => {
    const detail = await getOrganization(prisma, org.farm);
    expect(detail.profileActivities).toEqual([
      { id: 'crops', label: 'Coltivazioni e seminativi' },
      { id: 'vineyard_winery', label: 'Viticoltura e cantina' },
      { id: 'brewery', label: 'Birrificio' },
    ]);
    expect(JSON.stringify(detail)).not.toContain(`Cormons ${run}`);
    expect((await getOrganization(prisma, org.studio)).profileActivities).toBeNull();
  });

  it('never lets the database change a version', async () => {
    const [{ app: appRole }] = await prisma.$queryRaw<Array<{ app: boolean }>>`
      SELECT NOT has_table_privilege(current_user, 'company_profile_version', 'UPDATE') AS app`;
    await expect(
      prisma.$executeRaw`UPDATE company_profile_version SET activities = '{}' WHERE org_id = ${org.farm}::uuid`,
    ).rejects.toThrow(appRole ? /permission denied/ : /updates are not allowed/);
  });
});
