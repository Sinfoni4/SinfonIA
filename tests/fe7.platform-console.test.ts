/**
 * FE7 backend (docs/PROGETTO_FRONTEND_V2.md §5-§6; G1-G4, G9): the platform console has a token
 * of its own, only for platform administrators with a recent login; creating and suspending need
 * a fresh code; it shows counts and administrator contacts, never the data of organizations; every
 * action is in the platform audit log and in the organization's own log.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { SimulatedEmailSender } from '../src/core/email/email.sender.js';
import { LoginService } from '../src/core/identity/login.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, TEST_AUTH_SECRET, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('platform console boundaries (G3)', () => {
  it('reads no practice content, attachment or deadline across organizations', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../src/core/platform/platform.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/practiceAttachment|complianceDeadline|payload: true|ocrResult/);
  });
});

describe.runIf(Boolean(DATABASE_URL))('platform console (FE7)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const mail = new SimulatedEmailSender();
  let orgId: string;
  let adminId: string;
  let platformAdminId: string;
  const platformEmail = `gestore-${run}@fe7.local`;
  const otherPlatformEmail = `gestore2-${run}@fe7.local`;
  const memberEmail = `membro-${run}@fe7.local`;

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });
  const refreshOf = (res: { headers: Record<string, unknown> }) => {
    const h = res.headers['set-cookie'];
    const all = Array.isArray(h) ? h.join('\n') : typeof h === 'string' ? h : '';
    return /sinfonia_refresh=([^;]*)/.exec(all)?.[1] ?? '';
  };

  /** Whether the last login offered the console (the dashboard shows it as a choice). */
  let lastLoginPlatform: unknown;

  /** Logs in with the development code and returns the refresh cookie. */
  async function login(email: string): Promise<string> {
    const start = await post('/auth/login/start', { email });
    const { challengeId, devCode } = start.json<{
      data: { challengeId: string; devCode: string };
    }>().data;
    const verify = await post('/auth/login/verify', { challengeId, code: devCode });
    expect(verify.statusCode).toBe(200);
    lastLoginPlatform = verify.json<{ data: { platform: unknown } }>().data.platform;
    return refreshOf(verify);
  }

  /** A console token and the rotated cookie, or the refusal. */
  async function platformToken(refresh: string) {
    const res = await post('/auth/platform-token', {}, { cookie: `sinfonia_refresh=${refresh}` });
    return {
      res,
      token:
        res.statusCode === 200
          ? res.json<{ data: { accessToken: string } }>().data.accessToken
          : '',
      refresh: refreshOf(res) || refresh,
    };
  }

  async function verification(token: string) {
    const res = await post('/platform/verification', {}, { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(201);
    const { challengeId, devCode } = res.json<{
      data: { challengeId: string; devCode: string };
    }>().data;
    return { challengeId, code: devCode };
  }

  let token = '';
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (await new TenantRepository(prisma).createTenant({ name: `fe7-${run}` })).id;
    const users = new UserRepository(prisma);
    adminId = (await users.createUser(orgId, { email: `admin-${run}@fe7.local`, role: 'ADMIN' }))
      .id;
    await users.createUser(orgId, { email: memberEmail, role: 'MEMBER' });
    await users.createUser(orgId, { email: `chat-${run}@local.invalid`, role: 'ADMIN' });
    // Platform administrators are members of an organization too (old columns, until MF12).
    platformAdminId = (await users.createUser(orgId, { email: platformEmail, role: 'MEMBER' })).id;
    const other = await users.createUser(orgId, { email: otherPlatformEmail, role: 'MEMBER' });
    await prisma.user.updateMany({
      where: { id: { in: [platformAdminId, other.id] } },
      data: { platformRole: 'PLATFORM_ADMIN' },
    });
    await prisma.practice.create({
      data: {
        tenantId: orgId,
        userId: adminId,
        payload: { schemaVersion: 2, name: `Segreto industriale ${run}` },
      },
    });

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3009',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-fe7',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      RATE_LIMIT_AUTH_PER_MINUTE: '100000',
      AUTH_EMAIL_LOGIN: 'true',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      // exposeCodes is set here directly: the configuration allows it only in development.
      login: new LoginService(prisma, mail, TEST_AUTH_SECRET, { exposeCodes: true }),
      practiceService: practices,
      interpreterService: new InterpreterService(llm),
      executorService: new ExecutorService({ practiceService: practices }),
      contextService: new ContextService(practices),
      decisionEngine: new DecisionEngine(),
      normalizerService: new NormalizerService(),
    });
    await app.ready();
    token = (await platformToken(await login(platformEmail))).token;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('access (G1, G2)', () => {
    it('gives a console token only to platform administrators', async () => {
      expect(token).not.toBe('');
      const me = await get('/platform/me', bearer());
      expect(me.json<{ data: { email: string } }>().data.email).toBe(platformEmail);
      await login(platformEmail);
      expect(lastLoginPlatform).toBe(true);
      const refused = await platformToken(await login(memberEmail));
      expect(lastLoginPlatform).toBe(false);
      expect(refused.res.statusCode).toBe(401);
      expect(refused.res.json<{ error: { code: string } }>().error.code).toBe('PLATFORM_FORBIDDEN');
    });

    it('never mixes console and organization tokens', async () => {
      expect((await get('/platform/me', authHeaders(orgId, adminId, 'ADMIN'))).statusCode).toBe(
        401,
      );
      expect((await get('/members', bearer())).statusCode).toBe(401);
      expect((await get('/practices', bearer())).statusCode).toBe(401);
      expect((await get('/platform/organizations')).statusCode).toBe(401);
    });

    it('asks for a new login after 12 hours, and drops a removed role at once', async () => {
      const own = await platformToken(await login(otherPlatformEmail));
      const headers = { authorization: `Bearer ${own.token}` };
      expect((await get('/platform/me', headers)).statusCode).toBe(200);
      const sessionId = JSON.parse(
        Buffer.from(own.token.split('.')[1], 'base64url').toString(),
      ) as { sid: string };
      await prisma.session.update({
        where: { id: sessionId.sid },
        data: { createdAt: new Date(Date.now() - 13 * 60 * 60_000) },
      });
      const old = await get('/platform/me', headers);
      expect(old.statusCode).toBe(401);
      expect(old.json<{ error: { code: string } }>().error.code).toBe('PLATFORM_REAUTH');
      expect((await platformToken(own.refresh)).res.statusCode).toBe(401);

      const fresh = await platformToken(await login(otherPlatformEmail));
      await prisma.user.updateMany({
        where: { email: otherPlatformEmail },
        data: { platformRole: 'NONE' },
      });
      expect(
        (await get('/platform/me', { authorization: `Bearer ${fresh.token}` })).statusCode,
      ).toBe(401);
    });
  });

  describe('organizations (A1-A3, G3)', () => {
    let createdId = '';

    it('creates an organization only with a fresh code of the same administrator', async () => {
      const body = {
        name: `  Cooperativa   FE7 ${run} `,
        type: 'COOPERATIVE',
        firstAdminEmail: `primo-${run}@fe7.local`,
      };
      expect(
        (
          await post(
            '/platform/organizations',
            { ...body, verification: { challengeId: randomUUID(), code: '123456' } },
            bearer(),
          )
        ).statusCode,
      ).toBe(401);
      const code = await verification(token);
      expect(mail.lastTo(platformEmail)?.text).toContain(code.code);
      const res = await post('/platform/organizations', { ...body, verification: code }, bearer());
      expect(res.statusCode).toBe(201);
      createdId = res.json<{ data: { orgId: string } }>().data.orgId;
      // The same code cannot confirm a second action.
      expect(
        (
          await post(
            '/platform/organizations',
            { ...body, name: `Altra ${run}`, verification: code },
            bearer(),
          )
        ).statusCode,
      ).toBe(401);

      const org = await prisma.tenant.findUniqueOrThrow({ where: { id: createdId } });
      expect([org.name, org.type, org.status]).toEqual([
        `Cooperativa FE7 ${run}`,
        'COOPERATIVE',
        'ACTIVE',
      ]);
      // The first administrator gets an invitation, no account is created.
      expect(mail.lastTo(`primo-${run}@fe7.local`)?.text).toContain('Codice invito');
      const invitation = await prisma.invitation.findFirstOrThrow({ where: { orgId: createdId } });
      expect(invitation.role).toBe('ADMIN');
      const orgEvents = await prisma.auditLog.findMany({
        where: { tenantId: createdId },
        orderBy: { createdAt: 'asc' },
      });
      expect(orgEvents.map((e) => [e.eventType, e.userId])).toEqual([
        ['ORGANIZATION_CREATED', null],
        ['INVITATION_CREATED', null],
      ]);
      const platformEvents = await prisma.platformAuditLog.findMany({
        where: { orgId: createdId },
        orderBy: { createdAt: 'asc' },
      });
      expect(platformEvents.map((e) => [e.action, e.actorUserId])).toEqual([
        ['ORGANIZATION_CREATED', platformAdminId],
        ['FIRST_ADMIN_INVITED', platformAdminId],
      ]);
      const duplicate = await post(
        '/platform/organizations',
        { ...body, verification: await verification(token) },
        bearer(),
      );
      expect(duplicate.statusCode).toBe(409);
    });

    it('lists and shows counts and administrator contacts, never data of the organization', async () => {
      const list = await get(`/platform/organizations?search=fe7-${run}`, bearer());
      const items = list.json<{
        data: { items: Array<{ id: string; members: number; practices: number }> };
      }>().data.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: orgId, members: 5, practices: 1 });
      const detail = await get(`/platform/organizations/${orgId}`, bearer());
      const d = detail.json<{ data: { administrators: Array<{ email: string | null }> } }>().data;
      expect(d.administrators.map((a) => a.email)).toEqual([`admin-${run}@fe7.local`, null]);
      for (const res of [list, detail]) {
        expect(res.body).not.toMatch(/Segreto industriale|membro-|local\.invalid/);
      }
      expect((await get(`/platform/organizations/${randomUUID()}`, bearer())).statusCode).toBe(404);
    });

    it('suspends with a reason and a code, blocking members at once (G9)', async () => {
      const member = authHeaders(orgId, adminId, 'ADMIN');
      expect((await get('/members', member)).statusCode).toBe(200);
      const res = await post(
        `/platform/organizations/${orgId}/suspend`,
        { reason: 'Contratto sospeso', verification: await verification(token) },
        bearer(),
      );
      expect(res.statusCode).toBe(200);
      expect([401, 403]).toContain((await get('/members', member)).statusCode);
      const again = await post(
        `/platform/organizations/${orgId}/suspend`,
        { reason: 'Di nuovo', verification: await verification(token) },
        bearer(),
      );
      expect(again.statusCode).toBe(409);

      const back = await post(
        `/platform/organizations/${orgId}/reactivate`,
        { verification: await verification(token) },
        bearer(),
      );
      expect(back.statusCode).toBe(200);
      expect((await get('/members', member)).statusCode).toBe(200);
      const events = await prisma.auditLog.findMany({
        where: { tenantId: orgId, eventType: { startsWith: 'ORGANIZATION_' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => [e.eventType, e.userId, e.payload])).toEqual([
        ['ORGANIZATION_SUSPENDED', null, { byPlatform: true }],
        ['ORGANIZATION_REACTIVATED', null, { byPlatform: true }],
      ]);
    });
  });

  describe('platform audit log (A6)', () => {
    it('shows who did what to which organization', async () => {
      const res = await get(`/platform/audit?orgId=${orgId}`, bearer());
      const items = res.json<{
        data: {
          items: Array<{
            action: string;
            actorEmail: string | null;
            organization: { name: string | null } | null;
            details: Record<string, string>;
          }>;
        };
      }>().data.items;
      expect(items.map((i) => i.action)).toEqual([
        'ORGANIZATION_REACTIVATED',
        'ORGANIZATION_SUSPENDED',
      ]);
      expect(items[1]).toMatchObject({
        actorEmail: platformEmail,
        organization: { name: `fe7-${run}` },
        details: { reason: 'Contratto sospeso' },
      });
    });

    it('cannot be changed or deleted', async () => {
      await expect(prisma.platformAuditLog.deleteMany({ where: { orgId } })).rejects.toThrow();
      await expect(
        prisma.platformAuditLog.updateMany({ where: { orgId }, data: { action: 'X' } }),
      ).rejects.toThrow();
    });
  });

  describe('state of the system and use of the AI (A5, FE8)', () => {
    it('reports database, deliveries, scheduler and configured services', async () => {
      const res = await get('/platform/health', bearer());
      expect(res.statusCode).toBe(200);
      const h = res.json<{
        data: {
          database: { reachable: boolean; latencyMs: number };
          outbox: Record<string, number | null>;
          services: Record<string, unknown>;
        };
      }>().data;
      expect(h.database.reachable).toBe(true);
      expect(h.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(h.outbox).sort()).toEqual(
        [
          'deadLetter',
          'deadLetterLast24h',
          'failed',
          'oldestPendingMinutes',
          'pending',
          'processing',
        ].sort(),
      );
      expect(h.services).toEqual({ telegram: false, whatsapp: false, webhook: false, ai: null });
    });

    it('counts the use of the AI by organization, without any error text', async () => {
      const trace = (outcome: string, tokens: number | null, error: string | null = null) =>
        prisma.aiTrace.create({
          data: {
            tenantId: orgId,
            requestId: `fe8-${run}-${randomUUID()}`,
            model: 'mistral-small-latest',
            provider: 'mistral',
            outcome,
            latencyMs: 400,
            totalTokens: tokens,
            error,
          },
        });
      await trace('SUCCESS', 120);
      await trace('SUCCESS', 80);
      await trace('ERROR', null, `dati riservati ${run}`);
      const res = await get('/platform/ai-usage?days=1', bearer());
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(`dati riservati ${run}`);
      const usage = res.json<{
        data: {
          byOrganization: Array<{
            orgId: string;
            requests: number;
            tokens: number;
            errors: number;
          }>;
        };
      }>().data;
      expect(usage.byOrganization.find((o) => o.orgId === orgId)).toMatchObject({
        requests: 3,
        tokens: 200,
        errors: 1,
      });
      expect((await get('/platform/ai-usage?days=3', bearer())).statusCode).toBe(400);
    });

    it('is refused with an organization token', async () => {
      const res = await get('/platform/health', authHeaders(orgId, adminId, 'ADMIN'));
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe('module and functions of an organization (A02, A03)', () => {
    const patch = (url: string, payload: unknown, headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url, payload: payload as object, headers });
    let farmId = '';
    let farmAdmin = '';
    const farm = () => authHeaders(farmId, farmAdmin, 'ADMIN');

    beforeAll(async () => {
      farmId = (await new TenantRepository(prisma).createTenant({ name: `fe7-farm-${run}` })).id;
      farmAdmin = (
        await new UserRepository(prisma).createUser(farmId, {
          email: `farm-${run}@fe7.local`,
          role: 'ADMIN',
        })
      ).id;
    });

    it('is changed only from the console, with known modules and functions', async () => {
      const url = `/platform/organizations/${farmId}/modules`;
      const body = { module: 'agri', disabledFeatures: ['assistance'] };
      expect([401, 403]).toContain((await patch(url, body, farm())).statusCode);
      expect(
        (await patch(url, { module: 'agri', disabledFeatures: ['teleport'] }, bearer())).statusCode,
      ).toBe(400);
      expect(
        (await patch(url, { module: 'space', disabledFeatures: [] }, bearer())).statusCode,
      ).toBe(400);
      const res = await patch(url, body, bearer());
      expect(res.statusCode).toBe(200);
      const detail = await get(`/platform/organizations/${farmId}`, bearer());
      expect(
        detail.json<{ data: { module: string; disabledFeatures: string[] } }>().data,
      ).toMatchObject({ module: 'agri', disabledFeatures: ['assistance'] });
      // Recorded for the platform and, without the administrator's name, for the organization.
      expect(
        await prisma.platformAuditLog.count({
          where: { orgId: farmId, action: 'ORGANIZATION_MODULES_CHANGED' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { tenantId: farmId, eventType: 'ORGANIZATION_MODULES_CHANGED', userId: null },
        }),
      ).toBe(1);
      // The same choice again changes nothing and records nothing.
      expect((await patch(url, body, bearer())).statusCode).toBe(200);
      expect(
        await prisma.platformAuditLog.count({
          where: { orgId: farmId, action: 'ORGANIZATION_MODULES_CHANGED' },
        }),
      ).toBe(1);
    });

    it('refuses a function turned off in the backend, whatever the role, and says so', async () => {
      const res = await get('/assistance', farm());
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('FEATURE_DISABLED');
      const me = await get('/auth/me', farm());
      expect(
        me.json<{ data: { current: { disabledFeatures: string[] } } }>().data.current
          .disabledFeatures,
      ).toEqual(['assistance']);
      // Turned on again, it works at the next request.
      await patch(
        `/platform/organizations/${farmId}/modules`,
        { module: 'agri', disabledFeatures: [] },
        bearer(),
      );
      expect((await get('/assistance', farm())).statusCode).toBe(200);
    });

    it('offers the kinds and fields of the module and checks them', async () => {
      const current = await get('/modules/current', farm());
      expect(current.statusCode).toBe(200);
      const module = current.json<{
        data: { id: string; defaultKind: string; practiceTypes: Array<{ kind: string }> };
      }>().data;
      expect(module.id).toBe('agri');
      expect(module.practiceTypes.map((t) => t.kind)).toEqual(['generic', 'agri']);

      const created = await post(
        '/practices',
        { name: 'PAC 2027', kind: 'agri', fields: { procedure: 'pac', campaignYear: 2027 } },
        farm(),
      );
      expect(created.statusCode).toBe(201);
      const practice = created.json<{
        data: { id: string; kind: string; payload: { fields: object } };
      }>().data;
      expect(practice.kind).toBe('agri');
      expect(practice.payload.fields).toEqual({ procedure: 'pac', campaignYear: 2027 });

      // Without a kind: the module's default one.
      const plain = await post('/practices', { name: 'Senza tipo' }, farm());
      expect(plain.json<{ data: { kind: string } }>().data.kind).toBe('agri');

      const refused = [
        { name: 'Altro settore', kind: 'music' },
        { name: 'Campo ignoto', kind: 'agri', fields: { secret: 'x' } },
        { name: 'Valore errato', kind: 'agri', fields: { procedure: 'lottery' } },
        { name: 'Anno errato', kind: 'agri', fields: { campaignYear: 1800 } },
      ];
      for (const body of refused) {
        const res = await post('/practices', body, farm());
        expect(res.statusCode, body.name).toBe(400);
      }
      // Free metadata cannot smuggle fields past the module's checks.
      const smuggled = await post(
        '/practices',
        { name: 'Metadati', kind: 'agri', metadata: { fields: { secret: 'x' }, type: 'x' } },
        farm(),
      );
      expect(smuggled.statusCode).toBe(201);
      const payload = smuggled.json<{ data: { payload: Record<string, unknown> } }>().data.payload;
      expect(payload.fields).toBeUndefined();
      expect(payload.type).toBe('agri_practice');
    });

    it('sets a sub-state only of the type and in its common states', async () => {
      const created = await post('/practices', { name: 'Istruttoria', kind: 'agri' }, farm());
      const id = created.json<{ data: { id: string } }>().data.id;
      const set = (subState: string | null) =>
        post(`/practices/${id}/sub-state`, { subState }, farm());
      // «In istruttoria» is for SUBMITTED; the practice is CREATED.
      expect((await set('under_review')).statusCode).toBe(400);
      expect((await set('not_a_step')).statusCode).toBe(400);
      expect((await set('collecting_documents')).statusCode).toBe(200);
      const read = async () =>
        (await get(`/practices/${id}`, farm())).json<{ data: { subState: string | null } }>().data
          .subState;
      expect(await read()).toBe('collecting_documents');
      // A change of common state ends the step.
      expect(
        (await post(`/practices/${id}/transition`, { nextState: 'SUBMITTED' }, farm())).statusCode,
      ).toBe(200);
      expect(await read()).toBeNull();
      expect((await set('under_review')).statusCode).toBe(200);
      expect(await read()).toBe('under_review');
      expect(
        await prisma.auditLog.count({
          where: { tenantId: farmId, eventType: 'PRACTICE_SUB_STATE_CHANGED' },
        }),
      ).toBe(2);
    });
  });
});
