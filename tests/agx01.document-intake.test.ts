/**
 * AGX-01 (safe document intake): every file received leaves a trace in the audit, its SHA-256 is
 * kept, and the same file sent again by the same person is refused until they confirm. Only the
 * person's own practices (and the target one) are compared, so the check reveals nothing about the
 * practices of others or of other organizations.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DuplicateAttachmentError } from '../src/core/errors/attachment.errors.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { LocalStorageService } from '../src/data/storage/storage.service.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('safe document intake (AGX-01)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let service: PracticeApplicationService;
  let storageDir = '';
  let orgId = '';
  let otherOrgId = '';
  const people: Record<string, string> = {};
  const practices: Record<string, string> = {};
  // A plain-text receipt: read quickly, without OCR of an image.
  const content = Buffer.from(`RICEVUTA\nBar Centrale ${run}\nTotale EUR 12,50\nData 28/10/2026\n`);

  const upload = (userId: string, practiceId: string, extra: object = {}, tenantId = orgId) =>
    service.addAttachment({
      tenantId,
      userId,
      practiceId,
      fileName: 'ricevuta.txt',
      mimeType: 'text/plain',
      content,
      channel: 'telegram',
      ...extra,
    });

  const attachmentsOf = (practiceId: string) =>
    prisma.practiceAttachment.findMany({ where: { practiceId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    storageDir = mkdtempSync(path.join(tmpdir(), 'agx01-'));
    service = new PracticeApplicationService(prisma, {
      storageService: new LocalStorageService(storageDir),
    });
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `agx01-${run}` })).id;
    otherOrgId = (await tenants.createTenant({ name: `agx01-altra-${run}` })).id;
    const users = new UserRepository(prisma);
    people.member = (
      await users.createUser(orgId, { email: `socio-${run}@agx01.local`, role: 'MEMBER' })
    ).id;
    people.colleague = (
      await users.createUser(orgId, { email: `collega-${run}@agx01.local`, role: 'MEMBER' })
    ).id;
    people.outsider = (
      await users.createUser(otherOrgId, { email: `esterno-${run}@agx01.local`, role: 'ADMIN' })
    ).id;
    const practice = async (tenantId: string, userId: string, name: string) =>
      (await service.createPractice({ tenantId, userId, name })).id;
    practices.first = await practice(orgId, people.member, `Spese ottobre ${run}`);
    practices.second = await practice(orgId, people.member, `Spese novembre ${run}`);
    practices.colleague = await practice(orgId, people.colleague, `Collega ${run}`);
    practices.outsider = await practice(otherOrgId, people.outsider, `Esterna ${run}`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('keeps the hash of a new file and records it in the audit, without its name', async () => {
    const { attachment } = await upload(people.member, practices.first);
    const [stored] = await attachmentsOf(practices.first);
    expect(stored?.contentHash).toBe(createHash('sha256').update(content).digest('hex'));

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: orgId, eventType: 'ATTACHMENT_ADDED', userId: people.member },
    });
    expect(audit.payload).toEqual({
      practiceId: practices.first,
      attachmentId: attachment.id,
      ocrStatus: 'COMPLETED',
      documentType: 'receipt',
      channel: 'telegram',
      duplicateOf: null,
    });
    expect(JSON.stringify(audit.payload)).not.toContain('ricevuta.txt');
  });

  it('refuses the same file again, in the same or another own practice, saving nothing', async () => {
    for (const practiceId of [practices.first, practices.second]) {
      const err = await upload(people.member, practiceId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DuplicateAttachmentError);
      expect((err as DuplicateAttachmentError).duplicate.practiceName).toBe(`Spese ottobre ${run}`);
      expect((err as Error).message).toContain('Hai già caricato questo file');
    }
    expect(await attachmentsOf(practices.first)).toHaveLength(1);
    expect(await attachmentsOf(practices.second)).toHaveLength(0);
  });

  it('sends it again once the person confirms, recording what it repeats', async () => {
    const first = (await attachmentsOf(practices.first))[0];
    const { attachment } = await upload(people.member, practices.second, { allowDuplicate: true });
    expect(attachment.practiceId).toBe(practices.second);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        tenantId: orgId,
        eventType: 'ATTACHMENT_ADDED',
        payload: { path: ['attachmentId'], equals: attachment.id },
      },
    });
    expect(audit.payload).toMatchObject({ duplicateOf: first.id });
  });

  it('never compares with the practices of other people or organizations', async () => {
    await expect(upload(people.colleague, practices.colleague)).resolves.toBeTruthy();
    await expect(upload(people.outsider, practices.outsider, {}, otherOrgId)).resolves.toBeTruthy();
  });
});
