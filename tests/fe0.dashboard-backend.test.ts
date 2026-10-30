/**
 * FE0: what the backend gives the web dashboard (docs/PROGETTO_FRONTEND_V1.md §4, B1-B8):
 * refresh token only in an HttpOnly cookie, «esci da tutti i dispositivi», login code visible
 * only in development, invitations list, allowed next states, export channel, the dashboard
 * served from the same origin, strict content policy.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

function config(env: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '3009',
    DATABASE_URL: DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
    SERVICE_NAME: 'sinfonia-fe0',
    RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_AI_PER_MINUTE: '100000',
    RATE_LIMIT_TENANT_PER_MINUTE: '100000',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    ...TEST_AUTH_ENV,
    ...env,
  });
}

describe('development login code (B5)', () => {
  it('is allowed only with NODE_ENV=development', () => {
    expect(config({ NODE_ENV: 'development', AUTH_DEV_SHOW_CODE: 'true' }).AUTH_DEV_SHOW_CODE).toBe(
      true,
    );
    expect(() => config({ AUTH_DEV_SHOW_CODE: 'true' })).toThrow(/AUTH_DEV_SHOW_CODE/);
    expect(() => config({ NODE_ENV: 'production', AUTH_DEV_SHOW_CODE: 'true' })).toThrow(
      /AUTH_DEV_SHOW_CODE/,
    );
  });
});

describe.runIf(Boolean(DATABASE_URL))('backend for the dashboard (FE0)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let webDir: string;
  const mail = new SimulatedEmailSender();
  let orgId: string;
  let adminId: string;
  let memberId: string;
  const memberEmail = `membro-${run}@fe0.local`;
  // Logged out everywhere by its test: a person of its own, so the others keep their tokens.
  const leavingEmail = `uscente-${run}@fe0.local`;

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });
  const setCookie = (res: { headers: Record<string, string | string[] | number | undefined> }) => {
    const h = res.headers['set-cookie'];
    return Array.isArray(h) ? h.join('\n') : typeof h === 'string' ? h : '';
  };
  const refreshOf = (res: Parameters<typeof setCookie>[0]) =>
    /sinfonia_refresh=([^;]*)/.exec(setCookie(res))?.[1] ?? '';

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (await new TenantRepository(prisma).createTenant({ name: `fe0-${run}` })).id;
    const users = new UserRepository(prisma);
    adminId = (await users.createUser(orgId, { email: `admin-${run}@fe0.local`, role: 'ADMIN' }))
      .id;
    memberId = (await users.createUser(orgId, { email: memberEmail, role: 'MEMBER' })).id;
    await users.createUser(orgId, { email: leavingEmail, role: 'MEMBER' });

    webDir = await mkdtemp(path.join(tmpdir(), 'sinfonia-web-'));
    await mkdir(path.join(webDir, 'assets'));
    await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>SinfonIA</title>');
    await writeFile(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1);');

    const practices = new PracticeApplicationService(prisma);
    const cfg = config({ AUTH_EMAIL_LOGIN: 'true', WEB_DIST_DIR: webDir });
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
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    if (webDir) await rm(webDir, { recursive: true, force: true });
  });

  it('keeps the refresh token in an HttpOnly cookie, never in the page (B1, B5)', async () => {
    const start = await post('/auth/login/start', { email: memberEmail });
    const { challengeId, devCode } = start.json<{
      data: { challengeId: string; devCode?: string };
    }>().data;
    // The development code is the emailed one.
    expect(devCode).toMatch(/^\d{6}$/);
    expect(mail.lastTo(memberEmail)?.text).toContain(devCode);

    const verify = await post('/auth/login/verify', { challengeId, code: devCode });
    expect(verify.statusCode).toBe(200);
    expect(JSON.stringify(verify.json())).not.toContain('refreshToken');
    const cookie = setCookie(verify);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/auth']) {
      expect(cookie).toContain(attribute);
    }

    // Without the cookie there is no access token, and a token in the body is ignored.
    const refresh = refreshOf(verify);
    expect((await post('/auth/token', { orgId })).statusCode).toBe(401);
    expect((await post('/auth/token', { orgId, refreshToken: refresh })).statusCode).toBe(401);
    const token = await post('/auth/token', { orgId }, { cookie: `sinfonia_refresh=${refresh}` });
    expect(token.statusCode).toBe(200);
    expect(refreshOf(token)).not.toBe(refresh);
    expect(JSON.stringify(token.json())).not.toContain(refreshOf(token));
  });

  it('logs out everywhere with the access token (B4)', async () => {
    const start = await post('/auth/login/start', { email: leavingEmail });
    const { challengeId, devCode } = start.json<{
      data: { challengeId: string; devCode: string };
    }>().data;
    const verify = await post('/auth/login/verify', { challengeId, code: devCode });
    const cookie = { cookie: `sinfonia_refresh=${refreshOf(verify)}` };
    const token = await post('/auth/token', { orgId }, cookie);
    const bearer = {
      authorization: `Bearer ${token.json<{ data: { accessToken: string } }>().data.accessToken}`,
    };
    const next = { cookie: `sinfonia_refresh=${refreshOf(token)}` };

    const out = await post('/auth/logout-all', {}, bearer);
    expect(out.statusCode).toBe(204);
    expect(setCookie(out)).toContain('Max-Age=0');
    expect((await post('/auth/token', { orgId }, next)).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/practices', headers: bearer })).statusCode,
    ).toBe(401);
    expect((await post('/auth/logout-all', {})).statusCode).toBe(401);
  });

  it('lists invitations with their state, without tokens, to administrators (B3)', async () => {
    const admin = authHeaders(orgId, adminId, 'ADMIN');
    const created = await post(
      '/members/invitations',
      { email: `invitato-${run}@fe0.local`, role: 'OPERATOR' },
      admin,
    );
    const { invitationId } = created.json<{ data: { invitationId: string } }>().data;
    const list = await app.inject({ method: 'GET', url: '/members/invitations', headers: admin });
    expect(list.statusCode).toBe(200);
    const items = list.json<{ data: Array<Record<string, unknown>> }>().data;
    expect(items.find((i) => i.id === invitationId)).toMatchObject({
      role: 'OPERATOR',
      status: 'PENDING',
    });
    expect(JSON.stringify(items)).not.toMatch(/token/i);
    const asMember = await app.inject({
      method: 'GET',
      url: '/members/invitations',
      headers: authHeaders(orgId, memberId, 'MEMBER'),
    });
    expect(asMember.statusCode).toBe(403);
  });

  it('tells which next states the caller may set (B6) and labels dashboard exports (B8)', async () => {
    const practice = await new PracticeApplicationService(prisma).createPractice({
      tenantId: orgId,
      userId: memberId,
      name: `Pratica fe0 ${run}`,
      kind: 'music',
    });
    const detail = (userId: string, role: 'ADMIN' | 'MEMBER') =>
      app
        .inject({
          method: 'GET',
          url: `/practices/${practice.id}`,
          headers: authHeaders(orgId, userId, role),
        })
        .then((r) => r.json<{ data: { allowedTransitions: string[] } }>().data);
    expect((await detail(adminId, 'ADMIN')).allowedTransitions).toEqual(['VALIDATED', 'SUBMITTED']);
    expect((await detail(memberId, 'MEMBER')).allowedTransitions).toEqual([]);

    await post(
      '/practices/export',
      {},
      {
        ...authHeaders(orgId, memberId, 'MEMBER'),
        'x-sinfonia-client': 'web',
      },
    );
    await post('/practices/export', {}, authHeaders(orgId, adminId, 'ADMIN'));
    const channels = (
      await prisma.auditLog.findMany({
        where: { tenantId: orgId, eventType: 'EXPORT_GENERATED' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => (e.payload as { channel: string }).channel);
    expect(channels).toEqual(['web', 'api']);
  });

  it('serves the dashboard from the same origin, without authentication (B2)', async () => {
    const get = (url: string) => app.inject({ method: 'GET', url });
    const root = await get('/app');
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/app/');
    const index = await get('/app/');
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-cache');
    // Client-side routes get index.html.
    expect((await get('/app/pratiche/123')).body).toContain('<title>SinfonIA</title>');
    const asset = await get('/app/assets/app-abc123.js');
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await get('/app/assets/missing.js')).statusCode).toBe(404);
    // Never a file outside the dashboard folder.
    for (const url of ['/app/../package.json', '/app/%2e%2e/%2e%2e/package.json']) {
      expect((await get(url)).body).not.toContain('"name"');
    }
  });

  it('sends a strict content policy (B7)', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/' });
    const csp = String(res.headers['content-security-policy']);
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});
