/**
 * AGX-07: usage events (audit AG09). Each unit of work done for an organization leaves one row,
 * written with the work and keyed so that a retry never counts twice; the network's work through
 * a delegation is recorded with the network as the actor; rows are never changed, a wrong one is
 * reversed by a new one; the network sees only aggregates above the threshold (D4.1); the cost is
 * computed when reading, only in the platform console.
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
  requestAssistance,
  updateAssistanceRequest,
} from '../src/core/assistance/assistance.service.js';
import { MIN_COMPANIES, networkStats } from '../src/core/network/network-stats.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import {
  attachmentUsage,
  parseUsageRates,
  platformUsage,
  recordUsage,
  reverseUsageEvent,
} from '../src/core/usage/usage.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { AiTraceRepository } from '../src/data/repositories/ai-trace.repository.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { buildServer } from '../src/interface/http/server.js';
import { createLogger } from '../src/shared/logger.js';

import { authHeaders, TEST_AUTH_ENV, testPrincipals } from './helpers/auth.js';

import type { PrismaClient, UsageKind, UserRole } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60_000;

describe('usage of a file and rates', () => {
  it('counts the document, and only the pages actually read with OCR', () => {
    const kinds = (r: ReturnType<typeof attachmentUsage>) =>
      r.map((u) => [u.kind, u.quantity ?? 1]);
    expect(kinds(attachmentUsage('a'))).toEqual([
      ['DOCUMENT_RECEIVED', 1],
      ['OCR_PAGES', 0],
    ]);
    // A PDF with a text layer: no OCR.
    expect(
      kinds(attachmentUsage('a', { extraction: { source: 'pdf_text', pages: 9 } }))[1],
    ).toEqual(['OCR_PAGES', 0]);
    // A long scanned PDF is read only up to the limit.
    expect(
      kinds(attachmentUsage('a', { extraction: { source: 'ocr_pdf', pages: 40, ocrPages: 5 } }))[1],
    ).toEqual(['OCR_PAGES', 5]);
    // Results stored before AGX-07 have no ocrPages: the pages of an OCR read.
    expect(
      kinds(attachmentUsage('a', { extraction: { source: 'ocr_image', pages: 1 } }))[1],
    ).toEqual(['OCR_PAGES', 1]);
    expect(attachmentUsage('x').map((u) => u.key)).toEqual(['document.received:x', 'ocr.pages:x']);
  });

  it('reads the rates and refuses a wrong value instead of ignoring it', () => {
    expect(parseUsageRates(undefined)).toEqual({});
    expect(parseUsageRates('{"OCR_PAGES":0.002,"AI_CALL":0.01}')).toEqual({
      OCR_PAGES: 0.002,
      AI_CALL: 0.01,
    });
    expect(() => parseUsageRates('not json')).toThrow(/USAGE_RATES/);
    expect(() => parseUsageRates('{"PAGES":1}')).toThrow(/USAGE_RATES/);
    expect(() => parseUsageRates('{"OCR_PAGES":-1}')).toThrow();
  });
});

describe.runIf(Boolean(DATABASE_URL))('usage events (AGX-07)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let app: ReturnType<typeof buildServer>;
  let practices: PracticeApplicationService;
  const org = { company: '', network: '' };
  const people: Record<string, string> = {};
  let grant = '';
  let practiceId = '';

  const as = (o: keyof typeof org, who: string, role: UserRole) =>
    authHeaders(org[o], people[who], role);
  const companyAdmin = () => as('company', 'admin', 'ADMIN');
  const operator = () => as('network', 'netOperator', 'OPERATOR');
  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const events = (where: { tenantId?: string; practiceId?: string; kind?: UsageKind } = {}) =>
    prisma.usageEvent.findMany({
      where: { tenantId: org.company, ...where },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    const tenants = new TenantRepository(prisma);
    const users = new UserRepository(prisma);
    org.company = (await tenants.createTenant({ name: `Azienda ${run}`, module: 'agri' })).id;
    org.network = (await tenants.createTenant({ name: `TerreFVG ${run}` })).id;
    await prisma.tenant.update({ where: { id: org.network }, data: { type: 'NETWORK' } });
    const add = async (o: keyof typeof org, who: string, role: UserRole) => {
      people[who] = (
        await users.createUser(org[o], { email: `${who}-${run}@agx07.local`, role })
      ).id;
    };
    await add('company', 'admin', 'ADMIN');
    await add('company', 'farmer', 'MEMBER');
    await add('network', 'netAdmin', 'ADMIN');
    await add('network', 'netOperator', 'OPERATOR');

    const cfg = loadConfig({
      NODE_ENV: 'test',
      PORT: '3018',
      DATABASE_URL: DATABASE_URL!,
      SERVICE_NAME: 'sinfonia-agx07',
      RATE_LIMIT_PER_MINUTE: '100000',
      RATE_LIMIT_AI_PER_MINUTE: '100000',
      RATE_LIMIT_TENANT_PER_MINUTE: '100000',
      ...TEST_AUTH_ENV,
    });
    practices = new PracticeApplicationService(prisma);
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

    // The company delegates TerreFVG to open practices and work on them (AGX-04).
    const issued = await call('POST', '/grants', companyAdmin(), {
      grantee: { orgId: org.network },
      operations: ['READ', 'UPDATE', 'CREATE'],
      validUntil: new Date(Date.now() + 90 * DAY_MS).toISOString().slice(0, 10),
    });
    grant = issued.json<{ data: { id: string } }>().data.id;
    await call('POST', `/grants/${grant}/beneficiaries`, as('network', 'netAdmin', 'ADMIN'), {
      userId: people.netOperator,
    });
    await call('POST', `/grants/${grant}/beneficiaries/approve`, companyAdmin(), {
      userId: people.netOperator,
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('records the network’s work through a delegation, with the network as the actor', async () => {
    const created = await call('POST', `/grants/${grant}/practices`, operator(), {
      name: `Domanda PAC ${run}`,
    });
    expect(created.statusCode).toBe(201);
    practiceId = created.json<{ data: { id: string } }>().data.id;

    const upload = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/attachments`,
      operator(),
      {
        fileName: 'visura.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from(`visura ${run}`).toString('base64'),
      },
    );
    expect(upload.statusCode).toBe(201);
    const attachmentId = upload.json<{ data: { attachment: { id: string } } }>().data.attachment.id;

    const requested = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/document-requests`,
      operator(),
      { message: 'Serve il certificato BIO' },
    );
    expect(requested.statusCode).toBe(201);
    const requestId = requested.json<{ data: { id: string } }>().data.id;

    for (const nextState of ['VALIDATED', 'COMPLETED']) {
      const moved = await call(
        'POST',
        `/grants/${grant}/practices/${practiceId}/transition`,
        operator(),
        { nextState },
      );
      expect(moved.statusCode).toBe(200);
    }

    const rows = await events({ practiceId });
    expect(rows.map((r) => [r.kind, r.quantity, r.unit])).toEqual([
      ['PRACTICE_OPENED', 1, 'practice'],
      // A text file: received, no page read with OCR (a zero is not recorded).
      ['DOCUMENT_RECEIVED', 1, 'document'],
      ['DOCUMENT_REQUESTED', 1, 'request'],
      ['PRACTICE_COMPLETED', 1, 'practice'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ tenantId: org.company, actorOrgId: org.network });
      expect(r.userId).toBe(people.netOperator);
    }
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `practice.opened:${practiceId}`,
      `document.received:${attachmentId}`,
      `document.requested:${requestId}`,
      `practice.completed:${practiceId}`,
    ]);
  });

  it('counts the same work once, and nothing for work that did not happen', async () => {
    const before = (await events()).length;
    // A retry of the same work, e.g. a redelivered message: the key is already there.
    await recordUsage(prisma, [
      { key: `practice.opened:${practiceId}`, tenantId: org.company, kind: 'PRACTICE_OPENED' },
      { key: `practice.opened:${practiceId}`, tenantId: org.company, kind: 'PRACTICE_OPENED' },
    ]);
    // Completing it again is refused, and leaves no event.
    const again = await call(
      'POST',
      `/grants/${grant}/practices/${practiceId}/transition`,
      operator(),
      { nextState: 'COMPLETED' },
    );
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    // A request on a closed practice is refused: no event either.
    expect(
      (
        await call(
          'POST',
          `/grants/${grant}/practices/${practiceId}/document-requests`,
          operator(),
          {
            message: 'Serve altro',
          },
        )
      ).statusCode,
    ).toBe(409);
    // Work rolled back with its transaction leaves nothing.
    await expect(
      prisma.$transaction(async (tx) => {
        await recordUsage(tx, [
          { key: `rolled-back:${run}`, tenantId: org.company, kind: 'AI_CALL' },
        ]);
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    expect(await events()).toHaveLength(before);
  });

  it('records the organization’s own work without an actor', async () => {
    const own = await practices.createPractice({
      tenantId: org.company,
      userId: people.admin,
      name: `Bando PSR ${run}`,
    });
    const opened = await events({ practiceId: own.id });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ actorOrgId: null, userId: people.admin });

    // A call to the AI, with its tokens.
    await new AiTraceRepository(prisma).save({
      requestId: randomUUID(),
      tenantId: org.company,
      userId: people.farmer,
      model: 'test-model',
      provider: 'test',
      latencyMs: 120,
      outcome: 'SUCCESS',
      tokens: { promptTokens: 300, completionTokens: 50, totalTokens: 350 },
      timestamp: new Date().toISOString(),
    });
    expect((await events({ kind: 'AI_CALL' })).map((r) => r.quantity)).toEqual([1]);
    expect((await events({ kind: 'AI_TOKENS' })).map((r) => r.quantity)).toEqual([350]);

    // An assistance request closed, counted once.
    await requestAssistance(prisma, {
      tenantId: org.company,
      userId: people.farmer,
      topic: 'OTHER',
      channel: 'TELEGRAM',
    });
    const request = await prisma.assistanceRequest.findFirstOrThrow({
      where: { tenantId: org.company, userId: people.farmer },
    });
    await updateAssistanceRequest(prisma, {
      tenantId: org.company,
      id: request.id,
      actorUserId: people.admin,
      action: 'close',
    });
    await expect(
      updateAssistanceRequest(prisma, {
        tenantId: org.company,
        id: request.id,
        actorUserId: people.admin,
        action: 'close',
      }),
    ).rejects.toThrow();
    expect(await events({ kind: 'ASSISTANCE_CLOSED' })).toHaveLength(1);
  });

  it('never changes a recorded event', async () => {
    const [first] = await events();
    await expect(
      prisma.usageEvent.update({ where: { id: first.id }, data: { quantity: 99 } }),
    ).rejects.toThrow(/append-only/);
    expect((await prisma.usageEvent.findUniqueOrThrow({ where: { id: first.id } })).quantity).toBe(
      1,
    );
  });

  it('shows the organization its usage, and what the network did for it', async () => {
    const res = await call('GET', '/usage?period=month', companyAdmin());
    expect(res.statusCode).toBe(200);
    const usage = res.json<{
      data: {
        totals: Array<{ kind: string; quantity: number }>;
        byOthers: Array<{
          orgId: string;
          orgName: string;
          items: Array<{ kind: string; quantity: number }>;
        }>;
      };
    }>().data;
    const total = (kind: string) => usage.totals.find((t) => t.kind === kind)?.quantity;
    expect(total('PRACTICE_OPENED')).toBe(2);
    expect(total('PRACTICE_COMPLETED')).toBe(1);
    expect(total('AI_TOKENS')).toBe(350);
    expect(usage.byOthers).toEqual([
      {
        orgId: org.network,
        orgName: `TerreFVG ${run}`,
        items: [
          { kind: 'DOCUMENT_RECEIVED', quantity: 1 },
          { kind: 'PRACTICE_OPENED', quantity: 1 },
          { kind: 'PRACTICE_COMPLETED', quantity: 1 },
          { kind: 'DOCUMENT_REQUESTED', quantity: 1 },
        ],
      },
    ]);
    // Who does not read the activity log does not read this either.
    expect((await call('GET', '/usage', as('company', 'farmer', 'MEMBER'))).statusCode).toBe(403);
  });

  it('shows the network only aggregates above the threshold, and its own work', async () => {
    const stats = async () =>
      networkStats(prisma, {
        networkId: org.network,
        actorUserId: people.netAdmin,
        kind: 'month',
        previous: false,
      });
    const member = (childOrgId: string) =>
      prisma.organizationRelation.create({
        data: {
          parentOrgId: org.network,
          childOrgId,
          relationType: 'MEMBER_OF',
          status: 'ACTIVE',
          startedAt: new Date(Date.now() - DAY_MS),
        },
      });
    await member(org.company);
    // One member: nothing about the companies, but the network's own work through delegations.
    let s = await stats();
    expect(s.usage.every((u) => u.value === null)).toBe(true);
    expect(s.delegatedWork).toEqual([
      { kind: 'DOCUMENT_RECEIVED', quantity: 1 },
      { kind: 'PRACTICE_OPENED', quantity: 1 },
      { kind: 'PRACTICE_COMPLETED', quantity: 1 },
      { kind: 'DOCUMENT_REQUESTED', quantity: 1 },
    ]);

    // MIN_COMPANIES members, each receiving one document; only the company above opened practices
    // beyond its own, so kinds with fewer contributors stay hidden.
    const tenants = new TenantRepository(prisma);
    for (let i = 1; i < MIN_COMPANIES; i++) {
      const id = (await tenants.createTenant({ name: `Socia ${i} ${run}` })).id;
      await member(id);
      await recordUsage(prisma, [
        { key: `test.doc:${id}`, tenantId: id, kind: 'DOCUMENT_RECEIVED' },
      ]);
    }
    s = await stats();
    expect(s.usage.find((u) => u.kind === 'DOCUMENT_RECEIVED')?.value).toBe(MIN_COMPANIES);
    expect(s.usage.find((u) => u.kind === 'PRACTICE_OPENED')?.value).toBeNull();
    expect(s.usage.find((u) => u.kind === 'OCR_PAGES')?.value).toBe(0);
    // AI tokens stay a technical detail of the platform.
    expect(s.usage.some((u) => u.kind === 'AI_TOKENS')).toBe(false);
  });

  it('gives the platform the internal cost, and reverses a wrong event once', async () => {
    const rates = { AI_TOKENS: 0.001, PRACTICE_OPENED: 0.5 };
    const before = await platformUsage(prisma, { kind: 'month', previous: false, rates });
    const company = before.organizations.find((o) => o.orgId === org.company)!;
    expect(company.items.find((i) => i.kind === 'AI_TOKENS')).toEqual({
      kind: 'AI_TOKENS',
      quantity: 350,
      cost: 0.35,
    });
    expect(company.items.find((i) => i.kind === 'AI_CALL')?.cost).toBeNull();
    expect(company.cost).toBe(1.35);
    expect(before.ratesConfigured).toBe(true);

    const tokens = (await events({ kind: 'AI_TOKENS' }))[0];
    const audited: string[] = [];
    const audit = (_tx: unknown, e: { reversalId: string }) => {
      audited.push(e.reversalId);
      return Promise.resolve();
    };
    await expect(
      reverseUsageEvent(
        prisma,
        { eventId: tokens.id, reason: 'x', actorUserId: people.admin },
        audit,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE_REVERSAL', statusCode: 400 });
    const reversal = await reverseUsageEvent(
      prisma,
      { eventId: tokens.id, reason: 'Chiamata di prova', actorUserId: people.admin },
      audit,
    );
    expect(reversal).toMatchObject({ correctionOf: tokens.id, quantity: -350 });
    expect(audited).toEqual([reversal.id]);
    // Once only, and a reversal is never reversed.
    await expect(
      reverseUsageEvent(
        prisma,
        { eventId: tokens.id, reason: 'Di nuovo', actorUserId: people.admin },
        audit,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      reverseUsageEvent(
        prisma,
        { eventId: reversal.id, reason: 'Annulla', actorUserId: people.admin },
        audit,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The original stays as it was; the totals net it out.
    expect((await prisma.usageEvent.findUniqueOrThrow({ where: { id: tokens.id } })).quantity).toBe(
      350,
    );
    const after = await platformUsage(prisma, { kind: 'month', previous: false, rates });
    const now = after.organizations.find((o) => o.orgId === org.company)!;
    expect(now.items.find((i) => i.kind === 'AI_TOKENS')).toBeUndefined();
    expect(after.recent.find((r) => r.id === tokens.id)).toMatchObject({ reversed: true });
    expect(after.recent.find((r) => r.id === reversal.id)).toMatchObject({
      correctionOf: tokens.id,
      reason: 'Chiamata di prova',
    });
  });
});
