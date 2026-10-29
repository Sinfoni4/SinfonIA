/**
 * MF6 groundwork: login with a one-time code by email (simulated sender), sessions with rotated
 * refresh tokens, access tokens per organization, named invitations.
 * docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §4.1-§4.2, tests #3 and #17.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { SimulatedEmailSender } from '../src/core/email/email.sender.js';
import { LoginService, MAX_CHALLENGES_PER_HOUR } from '../src/core/identity/login.service.js';
import { revokeAllSessions } from '../src/core/identity/revocation.service.js';
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
    PORT: '3007',
    DATABASE_URL: DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
    SERVICE_NAME: 'sinfonia-mf6',
    RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_AI_PER_MINUTE: '100000',
    RATE_LIMIT_TENANT_PER_MINUTE: '100000',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    ...TEST_AUTH_ENV,
    ...env,
  });
}

describe('email login configuration', () => {
  it('stays off by default and is refused in production until a provider exists', () => {
    expect(config().AUTH_EMAIL_LOGIN).toBe(false);
    expect(config({ AUTH_EMAIL_LOGIN: 'true' }).AUTH_EMAIL_LOGIN).toBe(true);
    expect(() => config({ AUTH_EMAIL_LOGIN: 'true', NODE_ENV: 'production' })).toThrow(
      /AUTH_EMAIL_LOGIN/,
    );
  });
});

describe.runIf(Boolean(DATABASE_URL))('email login and invitations (MF6)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const mail = new SimulatedEmailSender();
  let orgA: string;
  let orgB: string;
  let adminA: string;
  let personId: string;
  const personEmail = `persona-${run}@mf6.local`;

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });
  const codeIn = (to: string) => /(\d{6})/.exec(mail.lastTo(to)?.text ?? '')?.[1] ?? '';
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const login = async (email: string) => {
    const start = await post('/auth/login/start', { email });
    const { challengeId } = start.json<{ data: { challengeId: string } }>().data;
    const verify = await post('/auth/login/verify', { challengeId, code: codeIn(email) });
    return verify.json<{
      data: {
        refreshToken: string;
        sessionId: string;
        organizations: Array<{ orgId: string; role: string }>;
      };
    }>().data;
  };
  // At most 5 codes per email and hour: each scenario logs in with its own person.
  const newPerson = async (name: string) => {
    const email = `${name}-${run}@mf6.local`;
    const user = await new UserRepository(prisma).createUser(orgA, { email, role: 'MEMBER' });
    return { id: user.id, email };
  };
  const token = async (refreshToken: string, orgId: string) => {
    const res = await post('/auth/token', { refreshToken, orgId });
    return {
      status: res.statusCode,
      ...(res.statusCode === 200
        ? res.json<{ data: { accessToken: string; refreshToken: string; expiresIn: number } }>()
            .data
        : { accessToken: '', refreshToken: '', expiresIn: 0 }),
    };
  };

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    orgA = (await tenants.createTenant({ name: `mf6-a-${run}` })).id;
    orgB = (await tenants.createTenant({ name: `mf6-b-${run}` })).id;
    const users = new UserRepository(prisma);
    adminA = (await users.createUser(orgA, { email: `admin-${run}@mf6.local`, role: 'ADMIN' })).id;
    personId = (await users.createUser(orgA, { email: personEmail, role: 'MEMBER' })).id;

    const practices = new PracticeApplicationService(prisma);
    const cfg = config({ AUTH_EMAIL_LOGIN: 'true' });
    const llm = { complete: () => Promise.reject(new Error('no LLM in this test')) };
    app = buildServer(cfg, createLogger(cfg), {
      principals: testPrincipals(prisma),
      prisma,
      login: new LoginService(prisma, mail, TEST_AUTH_SECRET),
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

  it('answers the same way for an unknown email and sends nothing', async () => {
    const before = mail.sent.length;
    const res = await post('/auth/login/start', { email: `nessuno-${run}@mf6.local` });
    expect(res.statusCode).toBe(202);
    const { challengeId } = res.json<{ data: { challengeId: string } }>().data;
    expect(challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mail.sent.length).toBe(before);
    const verify = await post('/auth/login/verify', { challengeId, code: '123456' });
    expect(verify.statusCode).toBe(401);
    // Placeholder emails of chat accounts never log in.
    await post('/auth/login/start', { email: `tg-${run}@local.invalid` });
    expect(mail.sent.length).toBe(before);
  });

  it('logs in with the code, once, and verifies the mailbox', async () => {
    const start = await post('/auth/login/start', { email: personEmail.toUpperCase() });
    const { challengeId } = start.json<{ data: { challengeId: string } }>().data;
    const code = codeIn(personEmail);
    expect(code).toMatch(/^\d{6}$/);
    expect((await post('/auth/login/verify', { challengeId, code: '000000' })).statusCode).toBe(
      401,
    );
    const ok = await post('/auth/login/verify', { challengeId, code });
    expect(ok.statusCode).toBe(200);
    const session = ok.json<{ data: { organizations: Array<{ orgId: string; role: string }> } }>()
      .data;
    expect(session.organizations).toEqual([
      expect.objectContaining({ orgId: orgA, role: 'MEMBER' }),
    ]);
    // The same code cannot be used twice.
    expect((await post('/auth/login/verify', { challengeId, code })).statusCode).toBe(401);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: personId } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({ where: { tenantId: orgA, eventType: 'LOGIN_SUCCEEDED' } }),
    ).toBe(1);
  });

  it('stops a challenge after 5 wrong codes and when it expires', async () => {
    const start = await post('/auth/login/start', { email: personEmail });
    const { challengeId } = start.json<{ data: { challengeId: string } }>().data;
    const code = codeIn(personEmail);
    for (let i = 0; i < 5; i++) await post('/auth/login/verify', { challengeId, code: '999999' });
    expect((await post('/auth/login/verify', { challengeId, code })).statusCode).toBe(401);

    const again = await post('/auth/login/start', { email: personEmail });
    const second = again.json<{ data: { challengeId: string } }>().data.challengeId;
    await prisma.authChallenge.update({
      where: { id: second },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await post('/auth/login/verify', { challengeId: second, code: codeIn(personEmail) }))
        .statusCode,
    ).toBe(401);
  });

  it('limits the codes per email and hour', async () => {
    const email = `limite-${run}@mf6.local`;
    await new UserRepository(prisma).createUser(orgA, { email, role: 'MEMBER' });
    for (let i = 0; i < MAX_CHALLENGES_PER_HOUR + 2; i++) {
      await post('/auth/login/start', { email });
    }
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(MAX_CHALLENGES_PER_HOUR);
  });

  it('gives 10-minute access tokens per organization and rotates the refresh token', async () => {
    const session = await login(personEmail);
    const first = await token(session.refreshToken, orgA);
    expect(first.status).toBe(200);
    expect(first.expiresIn).toBe(600);
    expect(
      (await app.inject({ method: 'GET', url: '/practices', headers: bearer(first.accessToken) }))
        .statusCode,
    ).toBe(200);
    // No access to an organization the person does not belong to.
    expect((await token(first.refreshToken, orgB)).status).toBe(401);

    const second = await token(first.refreshToken, orgA);
    expect(second.status).toBe(200);
    // The previous refresh token, presented again, revokes the whole session.
    expect((await token(first.refreshToken, orgA)).status).toBe(401);
    expect((await token(second.refreshToken, orgA)).status).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/practices', headers: bearer(second.accessToken) }))
        .statusCode,
    ).toBe(401);
  });

  it('ends the session at logout and at a global revocation', async () => {
    const other = await newPerson('logout');
    const a = await login(other.email);
    const access = await token(a.refreshToken, orgA);
    expect((await post('/auth/logout', { refreshToken: access.refreshToken })).statusCode).toBe(
      204,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/practices', headers: bearer(access.accessToken) }))
        .statusCode,
    ).toBe(401);

    const b = await login(other.email);
    const accessB = await token(b.refreshToken, orgA);
    await revokeAllSessions(prisma, other.id, { userId: adminA });
    expect((await token(accessB.refreshToken, orgA)).status).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/practices', headers: bearer(accessB.accessToken) }))
        .statusCode,
    ).toBe(401);
  });

  describe('invitations', () => {
    const invite = (email: string, role: string, orgId = orgA, by = adminA) =>
      post('/members/invitations', { email, role }, authHeaders(orgId, by, 'ADMIN'));
    const inviteToken = (email: string) =>
      /Codice invito: (\S+)/.exec(mail.lastTo(email)?.text ?? '')?.[1] ?? '';
    const accept = async (inviteTokenValue: string, email: string) => {
      const start = await post('/auth/invitations/start', { token: inviteTokenValue });
      if (start.statusCode !== 200) return start;
      const { challengeId } = start.json<{ data: { challengeId: string } }>().data;
      return post('/auth/invitations/accept', {
        token: inviteTokenValue,
        challengeId,
        code: codeIn(email),
      });
    };

    it('creates a new person with the invited role, only once', async () => {
      const email = `nuova-${run}@mf6.local`;
      expect((await invite(email, 'OPERATOR')).statusCode).toBe(201);
      const t = inviteToken(email);
      const res = await accept(t, email);
      expect(res.statusCode).toBe(200);
      const user = await prisma.user.findFirstOrThrow({ where: { email } });
      expect(user.emailVerifiedAt).not.toBeNull();
      const membership = await prisma.membership.findUniqueOrThrow({
        where: { userId_orgId: { userId: user.id, orgId: orgA } },
      });
      expect([membership.role, membership.status]).toEqual(['OPERATOR', 'ACTIVE']);
      expect((await accept(t, email)).statusCode).toBe(409);
    });

    it('adds a membership to an existing person instead of a second account', async () => {
      const adminB = (
        await new UserRepository(prisma).createUser(orgB, {
          email: `admin-b-${run}@mf6.local`,
          role: 'ADMIN',
        })
      ).id;
      const existing = await newPerson('esistente');
      expect((await invite(existing.email, 'MEMBER', orgB, adminB)).statusCode).toBe(201);
      expect((await accept(inviteToken(existing.email), existing.email)).statusCode).toBe(200);
      expect(await prisma.user.count({ where: { email: existing.email } })).toBe(1);
      const session = await login(existing.email);
      expect(session.organizations.map((o) => o.orgId).sort()).toEqual([orgA, orgB].sort());
    });

    it('refuses revoked invitations and invitations by non-admins', async () => {
      const email = `revocata-${run}@mf6.local`;
      const created = await invite(email, 'MEMBER');
      const { invitationId } = created.json<{ data: { invitationId: string } }>().data;
      const revoke = await post(
        `/members/invitations/${invitationId}/revoke`,
        {},
        authHeaders(orgA, adminA, 'ADMIN'),
      );
      expect(revoke.statusCode).toBe(200);
      expect((await accept(inviteToken(email), email)).statusCode).toBe(409);
      const byMember = await post(
        '/members/invitations',
        { email: `x-${run}@mf6.local`, role: 'ADMIN' },
        authHeaders(orgA, personId, 'MEMBER'),
      );
      expect(byMember.statusCode).toBe(403);
    });
  });
});
