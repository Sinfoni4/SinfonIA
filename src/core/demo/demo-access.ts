import { randomUUID } from 'node:crypto';

import { TenantRepository } from '../../data/repositories/tenant.repository.js';
import { UserRepository } from '../../data/repositories/user.repository.js';
import { validateAttachment } from '../practice/attachment-validation.js';
import { createDocumentRequest } from '../practice/document-request.js';

import type { StorageService } from '../../data/storage/storage.service.js';
import type { ComplianceService } from '../compliance/compliance.service.js';
import type { Feature } from '../features/features.js';
import type { PracticeApplicationService } from '../practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';

/**
 * Demo access (staging only, DEMO_ACCESS): the generic link `t.me/<bot>?start=demo` gives whoever
 * opens it from an unlinked Telegram account an account of their own in a separate organization,
 * «SinfonIA Demo», with invented data to try the chat and the Mini App. It never reaches a real
 * organization: the old organization invite code stays gone (AGX-10).
 *
 * - Each visitor is a MEMBER: they see only their own practices, never the other visitors'.
 * - The AI assistant (an external provider), assistance, exports and delegations are off for the
 *   demo organization; documents (local OCR), deadlines and the Mini App work.
 * - Demo accounts and their data are deleted after DEMO_TTL_DAYS; at most DEMO_PER_HOUR new ones
 *   per hour.
 */

export const DEMO_ORG_NAME = 'SinfonIA Demo';
const DEMO_ADMIN_EMAIL = 'demo.admin@sinfonia.test';
const DEMO_EMAIL = /^demo-[0-9a-f-]{36}@local\.invalid$/;
export const DEMO_TTL_DAYS = 7;
export const DEMO_PER_HOUR = 30;
const DEMO_OFF: Feature[] = ['ai_chat', 'assistance', 'exports', 'delegations', 'network_stats'];
const DAY_MS = 86_400_000;

export type DemoResult =
  { status: 'created'; orgName: string; days: number } | { status: 'linked' } | { status: 'busy' };

type Deps = {
  prisma: PrismaClient;
  practices: PracticeApplicationService;
  compliance: Pick<ComplianceService, 'createDeadline'>;
  now?: () => Date;
};

/** The demo organization and its administrator (who opens the visitors' practices). */
async function demoOrg(prisma: PrismaClient): Promise<{ orgId: string; adminId: string }> {
  let org = await prisma.tenant.findFirst({
    where: { name: DEMO_ORG_NAME, module: 'agri' },
    select: { id: true },
  });
  if (!org) {
    const created = await new TenantRepository(prisma).createTenant({
      name: DEMO_ORG_NAME,
      module: 'agri',
    });
    org = { id: created.id };
  }
  await prisma.tenant.update({ where: { id: org.id }, data: { disabledFeatures: DEMO_OFF } });
  const admin =
    (await prisma.user.findFirst({ where: { email: DEMO_ADMIN_EMAIL }, select: { id: true } })) ??
    (await new UserRepository(prisma).createUser(org.id, {
      email: DEMO_ADMIN_EMAIL,
      role: 'ADMIN',
    }));
  return { orgId: org.id, adminId: admin.id };
}

/**
 * Gives an unlinked Telegram account its own demo account with invented data. A linked account is
 * left as it is (`linked`): the demo never moves anyone out of a real organization.
 */
export async function startDemo(deps: Deps, telegramId: string): Promise<DemoResult> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const linked = await prisma.channelIdentity.count({
    where: { channel: 'TELEGRAM', externalId: telegramId.trim(), revokedAt: null },
  });
  if (linked > 0) return { status: 'linked' };
  const { orgId, adminId } = await demoOrg(prisma);
  const recent = await prisma.membership.count({
    where: {
      orgId,
      role: 'MEMBER',
      createdAt: { gt: new Date(now.getTime() - 60 * 60_000) },
    },
  });
  if (recent >= DEMO_PER_HOUR) return { status: 'busy' };

  const visitor = await new UserRepository(prisma).createUser(orgId, {
    email: `demo-${randomUUID()}@local.invalid`,
    role: 'MEMBER',
    telegramId: telegramId.trim(),
  });
  await seedDemoData(deps, { orgId, adminId, userId: visitor.id, now });
  return { status: 'created', orgName: DEMO_ORG_NAME, days: DEMO_TTL_DAYS };
}

/** Invented practices, documents, a document request and deadlines for one visitor. */
async function seedDemoData(
  deps: Deps,
  input: { orgId: string; adminId: string; userId: string; now: Date },
): Promise<void> {
  const { prisma, practices, compliance } = deps;
  const day = (n: number) => new Date(input.now.getTime() + n * DAY_MS).toISOString().slice(0, 10);
  const open = (name: string, fields: Record<string, unknown>) =>
    practices.createPractice({
      tenantId: input.orgId,
      userId: input.adminId,
      holderUserId: input.userId,
      name,
      kind: 'agri',
      fields,
    });
  const attach = async (practiceId: string, expectedKey: string, confirm: boolean) => {
    const { attachment } = await practices.addAttachment({
      tenantId: input.orgId,
      userId: input.adminId,
      practiceId,
      fileName: `${expectedKey}-esempio.txt`,
      mimeType: 'text/plain',
      content: Buffer.from(`Documento di esempio (${expectedKey}): dati inventati per la demo.`),
      expectedKey,
      channel: 'demo',
      allowDuplicate: true,
    });
    if (confirm) {
      await validateAttachment(prisma, {
        tenantId: input.orgId,
        practiceId,
        attachmentId: attachment.id,
        actorUserId: input.adminId,
        data: { documentType: 'receipt', fields: {} },
      });
    }
  };

  const psr = await open('Bando PSR 2026', { procedure: 'csr', campaignYear: 2026 });
  await attach(psr.id, 'farm_file', true);
  await attach(psr.id, 'identity', true);
  await createDocumentRequest(prisma, {
    tenantId: input.orgId,
    practiceId: psr.id,
    expectedKey: 'organic_certificate',
    message: 'Ci serve il certificato biologico: mandalo qui in chat anche come foto.',
    dueDate: day(8),
    actorUserId: input.adminId,
    requesterOrgId: input.orgId,
    channel: 'demo',
  });

  const pac = await open('Domanda PAC 2026', { procedure: 'pac', campaignYear: 2026 });
  await attach(pac.id, 'farm_file', true);
  for (const nextState of ['VALIDATED', 'SUBMITTED'] as const) {
    await practices.transitionPractice({
      tenantId: input.orgId,
      userId: input.adminId,
      practiceId: pac.id,
      nextState,
    });
  }

  for (const d of [
    { category: 'DURC', title: 'Rinnovo DURC', dueDate: day(3) },
    { category: 'CERTIFICAZIONE_BIO', title: 'Rinnovo certificato BIO', dueDate: day(12) },
  ] as const) {
    await compliance.createDeadline({
      tenantId: input.orgId,
      createdBy: input.adminId,
      userId: input.userId,
      ...d,
    });
  }
}

/**
 * Deletes the demo accounts older than DEMO_TTL_DAYS, with their practices (files included),
 * deadlines and links. Only accounts made by the demo (their placeholder email) and only in the
 * demo organization; the audit log keeps its rows.
 */
export async function expireDemoAccounts(
  prisma: PrismaClient,
  storage: Pick<StorageService, 'delete'>,
  now: Date = new Date(),
): Promise<number> {
  const org = await prisma.tenant.findFirst({
    where: { name: DEMO_ORG_NAME, module: 'agri' },
    select: { id: true },
  });
  if (!org) return 0;
  const old = await prisma.user.findMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - DEMO_TTL_DAYS * DAY_MS) },
      memberships: { some: { orgId: org.id } },
    },
    select: { id: true, email: true, memberships: { select: { orgId: true } } },
  });
  const visitors = old.filter(
    (u) => u.email && DEMO_EMAIL.test(u.email) && u.memberships.every((m) => m.orgId === org.id),
  );
  for (const visitor of visitors) {
    const practices = await prisma.practice.findMany({
      where: { tenantId: org.id, OR: [{ holderUserId: visitor.id }, { userId: visitor.id }] },
      select: { id: true, attachments: { select: { storagePath: true } } },
    });
    for (const p of practices) {
      for (const a of p.attachments)
        await storage.delete(org.id, a.storagePath).catch(() => undefined);
    }
    await prisma.$transaction([
      prisma.practice.deleteMany({ where: { id: { in: practices.map((p) => p.id) } } }),
      prisma.complianceDeadline.deleteMany({ where: { tenantId: org.id, userId: visitor.id } }),
      prisma.user.delete({ where: { id: visitor.id } }),
    ]);
  }
  return visitors.length;
}
