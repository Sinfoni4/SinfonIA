/**
 * MF0 phase 1: fills an empty, already migrated database with SYNTHETIC data in every table, so the
 * backup and restore test can run without any real data. Refuses any database whose name
 * contains "staging".
 *
 * Env: MF0_SOURCE_URL. Usage: npx tsx scripts/backup/mf0-synthetic-seed.ts
 */
import { ComplianceService } from '../../src/core/compliance/compliance.service.js';
import { PracticeApplicationService } from '../../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../../src/data/db/prisma.js';

async function main() {
  const url = process.env.MF0_SOURCE_URL;
  if (!url) throw new Error('MF0_SOURCE_URL is required');
  if (/staging/i.test(new URL(url).pathname)) throw new Error('Refusing a staging database');

  const prisma = createPrismaClient(url);
  try {
    if ((await prisma.tenant.count()) > 0) throw new Error('Database is not empty');
    const practices = new PracticeApplicationService(prisma);
    const compliance = new ComplianceService(prisma);

    for (const t of [1, 2]) {
      const tenant = await prisma.tenant.create({
        data: {
          name: `Cooperativa Sintetica ${t}`,
          schedulerEnabled: true,
          schedulerFrequency: 'monthly',
          schedulerTasks: [{ type: 'EXPORT_PRACTICES', frequency: 'monthly' }],
          webhookUrl: `https://hooks.example.test/coop-${t}`,
        },
      });
      await prisma.inviteCode.create({
        data: { code: `coop-${t}-invito-sintetico`, tenantId: tenant.id },
      });

      const users = [];
      for (const [i, role] of (['ADMIN', 'OPERATOR', 'MEMBER', 'MEMBER'] as const).entries()) {
        const user = await prisma.user.create({
          data: {
            tenantId: tenant.id,
            email: `persona${i}.coop${t}@esempio.test`,
            role,
            telegramId: String(900000000 + t * 100 + i),
          },
        });
        await prisma.userTenant.create({ data: { userId: user.id, tenantId: tenant.id } });
        users.push(user);
      }
      const member = users[2]!;
      await prisma.whatsappIdentity.create({
        data: { tenantId: tenant.id, userId: member.id, phoneNumber: `3933300000${t}` },
      });

      const created = [];
      for (const [i, owner] of users.entries()) {
        const practice = await practices.createPractice({
          tenantId: tenant.id,
          userId: owner.id,
          name: `Mario Sintetico ${t}-${i}`,
          kind: i % 2 ? 'artist' : 'music',
          metadata: { venue: `Teatro Inventato ${i}`, note: 'testo libero sintetico' },
        });
        created.push(practice);
      }
      await practices.transitionPractice({
        tenantId: tenant.id,
        practiceId: created[2]!.id,
        nextState: 'VALIDATED',
        userId: users[1]!.id,
      });

      await prisma.practiceAttachment.create({
        data: {
          tenantId: tenant.id,
          practiceId: created[2]!.id,
          fileName: 'fattura-sintetica.pdf',
          mimeType: 'application/pdf',
          fileSize: 1234,
          storagePath: `${tenant.id}/attachments/00000000-0000-4000-8000-00000000000${t}_fattura-sintetica.pdf`,
          ocrStatus: 'COMPLETED',
          ocrResult: {
            documentType: 'invoice',
            supplierName: 'Fornitore Inventato S.r.l.',
            supplierVat: '01234567890',
            documentDate: '2026-09-30',
            total: 122,
            items: [{ description: 'Servizio sintetico', quantity: 1, unitPrice: 100 }],
          },
        },
      });

      const deadline = await compliance.createDeadline({
        tenantId: tenant.id,
        createdBy: users[1]!.id,
        userId: member.id,
        category: 'DURC',
        title: `DURC sintetico ${t}`,
        dueDate: '2027-01-31',
        notes: 'nota sintetica con un nome inventato',
      });
      const outbox = await prisma.outboxMessage.create({
        data: {
          tenantId: tenant.id,
          eventType: 'COMPLIANCE_REMINDER',
          payload: { deadlineId: deadline.id, thresholdDays: 30, chatId: 900000000 + t },
          status: 'PROCESSED',
          deliveredTargets: [`telegram:${900000000 + t * 100}`, `whatsapp:3933300000${t}`],
          processedAt: new Date(),
        },
      });
      await prisma.complianceReminder.create({
        data: {
          tenantId: tenant.id,
          deadlineId: deadline.id,
          thresholdDays: 30,
          outboxMessageId: outbox.id,
        },
      });

      const job = await prisma.schedulerJob.create({
        data: {
          tenantId: tenant.id,
          taskType: 'EXPORT_PRACTICES',
          frequency: 'monthly',
          payload: { filter: { type: 'month' } },
        },
      });
      await prisma.schedulerRun.create({
        data: {
          tenantId: tenant.id,
          jobId: job.id,
          idempotencyKey: `scheduler:${tenant.id}:EXPORT_PRACTICES:2026-10`,
          status: 'COMPLETED',
          completedAt: new Date(),
          result: { count: created.length },
        },
      });
      await prisma.aiTrace.create({
        data: {
          tenantId: tenant.id,
          userId: users[0]!.id,
          requestId: `req-sintetica-${t}`,
          model: 'gpt-4o-mini',
          provider: 'openai',
          outcome: 'ERROR',
          action: 'transition_practice',
          latencyMs: 812,
          error: 'errore sintetico con testo libero',
        },
      });
      await prisma.conversationState.create({
        data: {
          userId: member.id,
          tenantId: tenant.id,
          lastPracticeId: created[2]!.id,
          onboardedAt: new Date(),
        },
      });
    }
    console.log('Synthetic data created');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`Seed failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
