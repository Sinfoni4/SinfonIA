/**
 * B2 (H6): roles an organization defines as a subset of a base role. They only take permissions
 * away or narrow them to the person's own practices, on every channel; at least one administrator
 * can always manage the members; a role never crosses organizations.
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
  authorize,
  PermissionDeniedError,
  permits,
} from '../src/core/authz/authorization.service.js';
import { customRoleProblems, parseCustomPermissions } from '../src/core/authz/permissions.js';
import { findChannelMemberships } from '../src/core/identity/membership.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient } from '@prisma/client';

describe('custom roles in the catalog (B2)', () => {
  it('never gives more than the base role', () => {
    expect(customRoleProblems('OPERATOR', { 'practice.read': 'tenant' })).toEqual([]);
    expect(customRoleProblems('OPERATOR', { 'members.manage': 'tenant' })).toEqual([
      '«members.manage» non fa parte del ruolo di base',
    ]);
    expect(customRoleProblems('MEMBER', { 'practice.read': 'tenant' })).toEqual([
      '«practice.read» vale solo per le proprie pratiche nel ruolo di base',
    ]);
    expect(customRoleProblems('ADMIN', {})).toEqual(['Scegli almeno un permesso']);
    // Stored rows with unknown permissions or scopes give nothing.
    expect(
      parseCustomPermissions(['practice.read:own', 'teleport:tenant', 'audit.read:all']),
    ).toEqual({ 'practice.read': 'own' });
  });

  it('allows the assigned scope only on practice reads, within the base role', () => {
    expect(customRoleProblems('OPERATOR', { 'practice.read': 'assigned' })).toEqual([]);
    expect(customRoleProblems('OPERATOR', { 'attachment.read': 'assigned' })).toEqual([]);
    expect(customRoleProblems('OPERATOR', { 'practice.transition': 'assigned' })).toEqual([
      '«practice.transition» non può valere per le pratiche assegnate',
    ]);
    // A MEMBER reads only their own practices: assigned would be more.
    expect(customRoleProblems('MEMBER', { 'practice.read': 'assigned' })).toEqual([
      '«practice.read» vale solo per le proprie pratiche nel ruolo di base',
    ]);
    expect(parseCustomPermissions(['practice.transition:assigned'])).toEqual({});
    const reader = {
      tenantId: 't',
      userId: 'u',
      role: 'OPERATOR' as const,
      customPermissions: { 'practice.read': 'assigned' as const },
    };
    expect(authorize(reader, 'practice.read').scope).toBe('assigned');
  });

  it('takes away permissions and narrows scopes in authorize()', () => {
    const operator = {
      tenantId: 't',
      userId: 'u',
      role: 'OPERATOR' as const,
      customPermissions: { 'practice.read': 'own' as const, 'practice.create': 'own' as const },
    };
    expect(authorize(operator, 'practice.read').scope).toBe('own');
    expect(() => authorize(operator, 'practice.transition')).toThrow(PermissionDeniedError);
    expect(permits(operator, 'practice.transition')).toBe(false);
    expect(permits(operator, 'practice.create')).toBe(true);
    // A tampered row asking for more than the base role is still capped by it.
    const member = {
      tenantId: 't',
      userId: 'u',
      role: 'MEMBER' as const,
      customPermissions: { 'practice.read': 'tenant' as const },
    };
    expect(authorize(member, 'practice.read').scope).toBe('own');
    // Without a custom role nothing changes.
    expect(authorize({ ...operator, customPermissions: null }, 'practice.read').scope).toBe(
      'tenant',
    );
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('custom roles with PostgreSQL (B2)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let orgId = '';
  let otherOrgId = '';
  let admin = '';
  let operator = '';
  let member = '';
  let otherAdmin = '';
  let practiceOfAdmin = '';
  const telegramId = `b2-${run}`;

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: object,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers: headers as Record<string, string>,
      ...(payload ? { payload } : {}),
    });
  const asAdmin = () => authHeaders(orgId, admin, 'ADMIN');
  const asOperator = () => authHeaders(orgId, operator, 'OPERATOR');

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    orgId = (await tenants.createTenant({ name: `b2-${run}` })).id;
    otherOrgId = (await tenants.createTenant({ name: `b2-altra-${run}` })).id;
    admin = (await users.createUser(orgId, { email: `admin-${run}@b2.local`, role: 'ADMIN' })).id;
    operator = (
      await users.createUser(orgId, {
        email: `operatore-${run}@b2.local`,
        role: 'OPERATOR',
        telegramId,
      })
    ).id;
    member = (await users.createUser(orgId, { email: `socio-${run}@b2.local`, role: 'MEMBER' })).id;
    otherAdmin = (
      await users.createUser(otherOrgId, { email: `altro-${run}@b2.local`, role: 'ADMIN' })
    ).id;

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3021',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-b2',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    const practices = new PracticeApplicationService(prisma);
    practiceOfAdmin = (
      await practices.createPractice({ tenantId: orgId, userId: admin, name: `Pratica ${run}` })
    ).id;
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

  let roleId = '';

  it('lets only administrators create roles, within the base role', async () => {
    const body = {
      name: 'Segreteria',
      baseRole: 'OPERATOR',
      permissions: {
        'practice.read': 'own',
        'practice.create': 'own',
        'compliance.read': 'tenant',
      },
    };
    expect((await call('POST', '/roles', asOperator(), body)).statusCode).toBe(403);
    const tooMuch = await call('POST', '/roles', asAdmin(), {
      ...body,
      permissions: { 'members.manage': 'tenant' },
    });
    expect(tooMuch.statusCode).toBe(400);
    const created = await call('POST', '/roles', asAdmin(), body);
    expect(created.statusCode).toBe(201);
    roleId = created.json<{ data: { id: string } }>().data.id;
    expect((await call('POST', '/roles', asAdmin(), body)).statusCode).toBe(409);
    const catalog = await call('GET', '/roles/catalog', asAdmin());
    expect(catalog.json<{ data: Record<string, object> }>().data.OPERATOR).toMatchObject({
      'practice.read': 'tenant',
    });
  });

  it('applies the role at the next request, on the API', async () => {
    // Before: an operator reads every practice of the organization.
    const before = await call('GET', '/practices', asOperator());
    expect(before.body).toContain(practiceOfAdmin);
    expect(
      (await call('POST', `/members/${member}/custom-role`, asAdmin(), { roleId })).statusCode,
    ).toBe(400); // a MEMBER cannot get a role built on OPERATOR
    expect(
      (await call('POST', `/members/${operator}/custom-role`, asAdmin(), { roleId })).statusCode,
    ).toBe(200);
    const after = await call('GET', '/practices', asOperator());
    expect(after.statusCode).toBe(200);
    expect(after.body).not.toContain(practiceOfAdmin);
    const transition = await call(
      'POST',
      `/practices/${practiceOfAdmin}/transition`,
      asOperator(),
      { nextState: 'VALIDATED' },
    );
    expect(transition.statusCode).toBe(403);
    const members = await call('GET', '/members', asAdmin());
    expect(members.json<{ data: Array<{ userId: string; customRole: unknown }> }>().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: operator,
          customRole: { id: roleId, name: 'Segreteria' },
        }),
      ]),
    );
  });

  it('applies the role in the chat and to the AI as well', async () => {
    const found = await findChannelMemberships(prisma, 'TELEGRAM', telegramId);
    expect(found?.options).toEqual([
      expect.objectContaining({
        tenantId: orgId,
        role: 'OPERATOR',
        customPermissions: {
          'practice.read': 'own',
          'practice.create': 'own',
          'compliance.read': 'tenant',
        },
      }),
    ]);
    const executor = new ExecutorService({
      practiceService: new PracticeApplicationService(prisma),
    });
    const refused = await executor.execute(
      {
        action: 'transition_practice',
        data: { practiceId: practiceOfAdmin, nextState: 'VALIDATED' },
      },
      {
        tenantId: orgId,
        userId: operator,
        role: 'OPERATOR',
        customPermissions: found!.options[0].customPermissions,
      },
    );
    expect(refused).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    // A context that does not say the custom role is refused (fail closed).
    const missing = await executor.execute({ action: 'list_practices', data: {} }, {
      tenantId: orgId,
      userId: operator,
      role: 'OPERATOR',
    } as never);
    expect(missing.success).toBe(false);
  });

  it('keeps an administrator who can manage the members', async () => {
    const res = await call('POST', '/roles', asAdmin(), {
      name: 'Amministrazione ridotta',
      baseRole: 'ADMIN',
      permissions: { 'practice.read': 'tenant', 'members.read': 'tenant' },
    });
    const reduced = res.json<{ data: { id: string } }>().data.id;
    const refused = await call('POST', `/members/${admin}/custom-role`, asAdmin(), {
      roleId: reduced,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('LAST_MEMBER_MANAGER');
  });

  it('never crosses organizations', async () => {
    // A role of another organization: not found from here.
    const foreign = await call('POST', '/roles', authHeaders(otherOrgId, otherAdmin, 'ADMIN'), {
      name: 'Esterno',
      baseRole: 'OPERATOR',
      permissions: { 'practice.read': 'tenant' },
    });
    const foreignId = foreign.json<{ data: { id: string } }>().data.id;
    expect(
      (await call('POST', `/members/${operator}/custom-role`, asAdmin(), { roleId: foreignId }))
        .statusCode,
    ).toBe(404);
    expect((await call('DELETE', `/roles/${foreignId}`, asAdmin())).statusCode).toBe(404);
    // The database refuses it too.
    await expect(
      prisma.membership.update({
        where: { userId_orgId: { userId: operator, orgId } },
        data: { customRoleId: foreignId },
      }),
    ).rejects.toThrow();
  });

  it('cannot delete a role in use; a new base role drops the custom one', async () => {
    expect((await call('DELETE', `/roles/${roleId}`, asAdmin())).statusCode).toBe(409);
    expect(
      (await call('POST', `/members/${operator}/role`, asAdmin(), { role: 'MEMBER' })).statusCode,
    ).toBe(200);
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_orgId: { userId: operator, orgId } },
      select: { customRoleId: true },
    });
    expect(membership.customRoleId).toBeNull();
    expect((await call('DELETE', `/roles/${roleId}`, asAdmin())).statusCode).toBe(200);
    const events = await prisma.auditLog.findMany({
      where: { tenantId: orgId, eventType: { startsWith: 'CUSTOM_ROLE' } },
      select: { eventType: true },
    });
    expect(events.map((e) => e.eventType).sort()).toEqual([
      'CUSTOM_ROLE_CREATED',
      'CUSTOM_ROLE_CREATED',
      'CUSTOM_ROLE_DELETED',
    ]);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: orgId, eventType: 'MEMBER_CUSTOM_ROLE_CHANGED' },
      }),
    ).toBe(1);
  });
  it('lets a role see its own practices and those assigned to the person, nothing else', async () => {
    const follower = (
      await new UserRepository(prisma).createUser(orgId, {
        email: `segue-${run}@b2.local`,
        role: 'OPERATOR',
      })
    ).id;
    const practices = new PracticeApplicationService(prisma);
    const assigned = await practices.createPractice({
      tenantId: orgId,
      userId: admin,
      name: `Assegnata ${run}`,
    });
    await prisma.practice.update({ where: { id: assigned.id }, data: { assignedTo: follower } });
    const own = await practices.createPractice({
      tenantId: orgId,
      userId: follower,
      name: `Sua ${run}`,
    });
    const created = await call('POST', '/roles', asAdmin(), {
      name: 'Segue le pratiche',
      baseRole: 'OPERATOR',
      permissions: { 'practice.read': 'assigned', 'attachment.read': 'assigned' },
    });
    expect(created.statusCode).toBe(201);
    const followRole = created.json<{ data: { id: string } }>().data.id;
    expect(
      (await call('POST', `/members/${follower}/custom-role`, asAdmin(), { roleId: followRole }))
        .statusCode,
    ).toBe(200);
    const asFollower = () => authHeaders(orgId, follower, 'OPERATOR');

    const list = await call('GET', '/practices?limit=100', asFollower());
    const ids = list.json<{ data: { items: Array<{ id: string }> } }>().data.items.map((p) => p.id);
    expect(ids.sort()).toEqual([assigned.id, own.id].sort());
    expect((await call('GET', `/practices/${assigned.id}`, asFollower())).statusCode).toBe(200);
    expect(
      (await call('GET', `/practices/${assigned.id}/attachments`, asFollower())).statusCode,
    ).toBe(200);
    // Another practice of the organization: as if it did not exist.
    expect((await call('GET', `/practices/${practiceOfAdmin}`, asFollower())).statusCode).toBe(404);
    // Reading what one follows is not changing it.
    expect(
      (
        await call('POST', `/practices/${assigned.id}/transition`, asFollower(), {
          nextState: 'VALIDATED',
        })
      ).statusCode,
    ).toBe(403);
  });
});
