/**
 * AGX-04: operational delegations. Through a delegation a network operator opens practices for a
 * company (CREATE), lists and downloads its documents (READ), uploads documents, confirms the data
 * read from them and sets the step (UPDATE). Every route is checked against the delegation at each
 * request, refuses a revoked or expired one, and records DELEGATED_ACCESS in the company's log.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextService } from '../src/ai/context/context.service.js';
import { DecisionEngine } from '../src/ai/decision/decision.engine.js';
import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { InterpreterService } from '../src/ai/interpreter/interpreter.service.js';
import { NormalizerService } from '../src/ai/normalization/normalizer.service.js';
import { loadConfig } from '../src/config/config.js';
import { checkDelegation } from '../src/core/delegation/delegation.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

describe('AGX-04 operations', () => {
  it('offers CREATE, still not APPROVE or DELETE', () => {
    const until = new Date(Date.now() + 30 * DAY_MS);
    expect(checkDelegation(['READ', 'CREATE'], until)).toEqual(['READ', 'CREATE']);
    expect(() => checkDelegation(['READ', 'APPROVE'], until)).toThrow(/non ancora disponibili/);
    expect(() => checkDelegation(['READ', 'DELETE'], until)).toThrow(/non ancora disponibili/);
  });
});

describe.runIf(Boolean(DATABASE_URL))('delegated operations (AGX-04)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  const org = { company: '', network: '', studio: '' };
  const people: Record<string, string> = {};
  let grant = '';
  let readOnlyGrant = '';
  let practiceId = '';
  let attachmentId = '';

  const as = (o: keyof typeof org, who: string, role: UserRole) =>
    authHeaders(org[o], people[who], role);
  const operator = () => as('network', 'netOperator', 'OPERATOR');
  const consultant = () => as('studio', 'consultant', 'ADMIN');
  const companyAdmin = () => as('company', 'issuer', 'ADMIN');
  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const uses = (action: string) =>
    prisma.auditLog.count({
      where: {
        tenantId: org.company,
        eventType: 'DELEGATED_ACCESS',
        payload: { path: ['action'], equals: action },
      },
    });
  const upload = (grantId: string, headers: Record<string, string>, text = `visura ${run}`) =>
    call('POST', `/grants/${grantId}/practices/${practiceId}/attachments`, headers, {
      fileName: 'visura.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from(text).toString('base64'),
    });
  const routes = (grantId: string) => [
    call('POST', `/grants/${grantId}/practices`, operator(), { name: `Altra ${run}` }),
    call('GET', `/grants/${grantId}/practices/${practiceId}`, operator()),
    call(
      'GET',
      `/grants/${grantId}/practices/${practiceId}/attachments/${attachmentId}/download`,
      operator(),
    ),
    upload(grantId, operator(), `altro ${randomUUID()}`),
    call(
      'POST',
      `/grants/${grantId}/practices/${practiceId}/attachments/${attachmentId}/validation`,
      operator(),
      { documentType: 'receipt', fields: {} },
    ),
    call('POST', `/grants/${grantId}/practices/${practiceId}/sub-state`, operator(), {
      subState: null,
    }),
  ];

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.company = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    org.network = (await tenants.createTenant({ name: `Rete ${run}` })).id;
    org.studio = (await tenants.createTenant({ name: `Studio ${run}` })).id;
    await prisma.tenant.update({ where: { id: org.network }, data: { type: 'NETWORK' } });
    const add = async (o: keyof typeof org, who: string, role: UserRole) => {
      people[who] = (
        await users.createUser(org[o], { email: `${who}-${run}@agx04.local`, role })
      ).id;
    };
    // The first administrator is the fallback owner; the issuer gives the delegations.
    await add('company', 'firstAdmin', 'ADMIN');
    await add('company', 'issuer', 'ADMIN');
    await add('network', 'netAdmin', 'ADMIN');
    await add('network', 'netOperator', 'OPERATOR');
    await add('studio', 'consultant', 'ADMIN');
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3015',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-agx04',
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

    // The company delegates its network (READ, CREATE, UPDATE) and approves the operator.
    const issued = await call('POST', '/grants', companyAdmin(), {
      grantee: { orgId: org.network },
      operations: ['READ', 'CREATE', 'UPDATE'],
      validUntil: isoDay(180),
    });
    expect(issued.statusCode).toBe(201);
    grant = issued.json<{ data: { id: string } }>().data.id;
    await call('POST', `/grants/${grant}/beneficiaries`, as('network', 'netAdmin', 'ADMIN'), {
      userId: people.netOperator,
    });
    const approved = await call('POST', `/grants/${grant}/beneficiaries/approve`, companyAdmin(), {
      userId: people.netOperator,
    });
    expect(approved.statusCode).toBe(200);
    // And a consultant may only read.
    const readOnly = await call('POST', '/grants', companyAdmin(), {
      grantee: { email: `consultant-${run}@agx04.local` },
      operations: ['READ'],
      validUntil: isoDay(60),
    });
    readOnlyGrant = readOnly.json<{ data: { id: string } }>().data.id;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('opens a practice for the company, owned by who issued the delegation', async () => {
    const res = await call('POST', `/grants/${grant}/practices`, operator(), {
      name: `Domanda PAC ${run}`,
      kind: 'agri',
      fields: { procedure: 'pac', campaignYear: 2026 },
    });
    expect(res.statusCode).toBe(201);
    const practice = res.json<{ data: { id: string; userId: string; tenantId: string } }>().data;
    practiceId = practice.id;
    expect(practice).toMatchObject({ tenantId: org.company, userId: people.issuer });

    // The creation is recorded with the operator who acted, in the company's log.
    const created = await prisma.auditLog.findFirstOrThrow({
      where: {
        tenantId: org.company,
        eventType: 'PRACTICE_CREATED',
        payload: { path: ['practiceId'], equals: practiceId },
      },
    });
    expect(created.userId).toBe(people.netOperator);
    expect(await uses('create')).toBe(1);

    // The company sees it among its own practices.
    const own = await call('GET', '/practices?limit=100', companyAdmin());
    expect(
      own.json<{ data: { items: Array<{ id: string }> } }>().data.items.map((p) => p.id),
    ).toContain(practiceId);
    // A body naming an owner is refused: the delegation decides it.
    const withOwner = await call('POST', `/grants/${grant}/practices`, operator(), {
      name: `Con titolare ${run}`,
      holderUserId: people.netOperator,
    });
    expect(withOwner.statusCode).toBe(400);
  });

  it('gives the module of the company with the list, for the new practice form', async () => {
    const res = await call('GET', `/grants/${grant}/practices`, operator());
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { module: { id: string; practiceTypes: Array<{ kind: string }> } };
    }>().data;
    expect(body.module.id).toBe('agri');
    expect(body.module.practiceTypes.map((t) => t.kind)).toContain('agri');
  });

  it('uploads, lists and downloads documents of the practice', async () => {
    const res = await upload(grant, operator());
    expect(res.statusCode).toBe(201);
    attachmentId = res.json<{ data: { attachment: { id: string } } }>().data.attachment.id;
    const added = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: org.company, eventType: 'ATTACHMENT_ADDED' },
    });
    expect(added.userId).toBe(people.netOperator);
    expect(added.payload).toMatchObject({ practiceId, channel: 'delegation' });
    expect(await uses('upload')).toBe(1);

    const detail = await call('GET', `/grants/${grant}/practices/${practiceId}`, operator());
    expect(detail.statusCode).toBe(200);
    const data = detail.json<{
      data: {
        attachments: Array<{ id: string }>;
        delegation: { operations: string[] };
        module: { id: string };
      };
    }>().data;
    expect(data.attachments.map((a) => a.id)).toEqual([attachmentId]);
    expect(data.delegation.operations).toEqual(['READ', 'CREATE', 'UPDATE']);
    expect(data.module.id).toBe('agri');

    const file = await call(
      'GET',
      `/grants/${grant}/practices/${practiceId}/attachments/${attachmentId}/download`,
      operator(),
    );
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe(`visura ${run}`);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(await uses('download')).toBe(1);
  });

  it('confirms the data of a document and sets the step', async () => {
    const checked = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/attachments/${attachmentId}/validation`,
      operator(),
      { documentType: 'receipt', fields: { merchantName: 'CAA', totalAmount: 12.5 } },
    );
    expect(checked.statusCode).toBe(200);
    const row = await prisma.practiceAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { validatedBy: true },
    });
    expect(row.validatedBy).toBe(people.netOperator);
    expect(await uses('validation')).toBe(1);

    const step = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/sub-state`,
      operator(),
      {
        subState: 'collecting_documents',
      },
    );
    expect(step.statusCode).toBe(200);
    expect(step.json<{ data: { subState: string } }>().data.subState).toBe('collecting_documents');
    expect(await uses('sub_state')).toBe(1);
  });

  it('allows a read-only delegation to download, nothing else', async () => {
    const download = await call(
      'GET',
      `/grants/${readOnlyGrant}/practices/${practiceId}/attachments/${attachmentId}/download`,
      consultant(),
    );
    expect(download.statusCode).toBe(200);
    const refused = [
      await call('POST', `/grants/${readOnlyGrant}/practices`, consultant(), { name: `X ${run}` }),
      await upload(readOnlyGrant, consultant(), `y ${randomUUID()}`),
      await call(
        'POST',
        `/grants/${readOnlyGrant}/practices/${practiceId}/attachments/${attachmentId}/validation`,
        consultant(),
        { documentType: 'receipt', fields: {} },
      ),
      await call(
        'POST',
        `/grants/${readOnlyGrant}/practices/${practiceId}/sub-state`,
        consultant(),
        {
          subState: null,
        },
      ),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('OPERATION_NOT_DELEGATED');
    }
    // A delegation of another person is not usable by the operator.
    const other = await call('GET', `/grants/${readOnlyGrant}/practices/${practiceId}`, operator());
    expect(other.statusCode).toBe(404);
  });

  it('gives the practice to the oldest administrator when the issuer has left', async () => {
    await prisma.membership.updateMany({
      where: { orgId: org.company, userId: people.issuer },
      data: { status: 'SUSPENDED' },
    });
    const res = await call('POST', `/grants/${grant}/practices`, operator(), {
      name: `Dopo ${run}`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { userId: string } }>().data.userId).toBe(people.firstAdmin);
    await prisma.membership.updateMany({
      where: { orgId: org.company, userId: people.issuer },
      data: { status: 'ACTIVE' },
    });
  });

  it('refuses every delegated route once the delegation expires or is revoked', async () => {
    const before = await prisma.auditLog.count({
      where: { tenantId: org.company, eventType: 'DELEGATED_ACCESS' },
    });
    await prisma.accessGrant.update({
      where: { id: grant },
      data: {
        validFrom: new Date(Date.now() - 2 * DAY_MS),
        validUntil: new Date(Date.now() - 1000),
      },
    });
    for (const res of await Promise.all(routes(grant))) expect(res.statusCode).toBe(404);

    await prisma.accessGrant.update({
      where: { id: grant },
      data: { validUntil: new Date(Date.now() + 30 * DAY_MS) },
    });
    expect((await call('POST', `/grants/${grant}/revoke`, companyAdmin(), {})).statusCode).toBe(
      200,
    );
    for (const res of await Promise.all(routes(grant))) expect(res.statusCode).toBe(404);

    // Refusals are not uses: nothing was added to the log, and no practice or file was created.
    expect(
      await prisma.auditLog.count({
        where: { tenantId: org.company, eventType: 'DELEGATED_ACCESS' },
      }),
    ).toBe(before);
    expect(await prisma.practice.count({ where: { tenantId: org.company } })).toBe(2);
    expect(await prisma.practiceAttachment.count({ where: { tenantId: org.company } })).toBe(1);
  });
});
