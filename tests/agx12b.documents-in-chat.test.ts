/**
 * AGX-12b: «documenti» in chat. For each of one's open practices: the documents its type expects
 * with their state, the other files sent and the documents asked for, with their due date. Only
 * one's own practices, as for the other chat commands.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDocumentRequest } from '../src/core/practice/document-request.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { parsePracticeCommand } from '../src/core/practice/practice.commands.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { MENU_BUTTONS } from '../src/interface/conversation/conversation.service.js';
import {
  formatPracticeCommandResult,
  formatPracticeDocuments,
} from '../src/interface/telegram/practice.command.formatter.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;

describe('the «documenti» command', () => {
  it('is understood with or without a practice name', () => {
    for (const text of ['documenti', 'Documenti', 'i miei documenti', 'documenti?']) {
      expect(parsePracticeCommand(text)).toEqual({
        type: 'LIST_PRACTICE_DOCUMENTS',
        payload: { name: null },
      });
    }
    for (const text of ['documenti Domanda PAC', 'documenti pratica Domanda PAC']) {
      expect(parsePracticeCommand(text)).toEqual({
        type: 'LIST_PRACTICE_DOCUMENTS',
        payload: { name: 'Domanda PAC' },
      });
    }
    expect(parsePracticeCommand('mandami i documenti della vendemmia per favore')).toBeNull();
  });

  it('is in the chat menu', () => {
    expect(MENU_BUTTONS).toContainEqual({ label: '📎 I miei documenti', answer: 'documenti' });
  });

  it('shows the state of each document, the due date of a request and the files sent', () => {
    const text = formatPracticeDocuments({
      name: 'Domanda PAC',
      status: 'CREATED',
      expected: [
        { label: 'Fascicolo aziendale', required: true, state: 'valid' },
        { label: 'Certificato biologico', required: true, state: 'missing' },
        { label: 'Visura', required: false, state: 'missing' },
      ],
      files: [{ fileName: 'foto.jpg', state: 'unreadable' }],
      otherFiles: 0,
      requests: [
        { label: 'Certificato biologico', message: 'Serve', dueDate: '2026-11-15' },
        { label: null, message: 'La mappa dei campi', dueDate: null },
      ],
    });
    expect(text.split('\n')).toEqual([
      '📁 Domanda PAC',
      '✅ Fascicolo aziendale — confermato',
      '⬜ Certificato biologico — manca · richiesto entro il 15/11/2026',
      '⬜ Visura — manca (facoltativo)',
      '📨 Richiesto: La mappa dei campi',
      '📎 foto.jpg — ⚠️ non leggibile',
    ]);
  });
});

describe.runIf(Boolean(DATABASE_URL))('documents in chat on the database (AGX-12b)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let practices: PracticeApplicationService;
  let orgId = '';
  const people: Record<string, string> = {};
  let practiceId = '';
  const actor = (who: string) => ({
    tenantId: orgId,
    userId: people[who],
    role: 'MEMBER' as const,
    customPermissions: null,
  });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    orgId = (
      await new TenantRepository(prisma).createTenant({ name: `Azienda ${run}`, module: 'agri' })
    ).id;
    const users = new UserRepository(prisma);
    for (const who of ['farmer', 'neighbour', 'admin']) {
      people[who] = (
        await users.createUser(orgId, {
          email: `${who}-${run}@agx12b.local`,
          role: who === 'admin' ? 'ADMIN' : 'MEMBER',
        })
      ).id;
    }
    practices = new PracticeApplicationService(prisma);
    practiceId = (
      await practices.createPractice({
        tenantId: orgId,
        userId: people.farmer,
        name: `Domanda PAC ${run}`,
      })
    ).id;
    await practices.addAttachment({
      tenantId: orgId,
      userId: people.farmer,
      practiceId,
      fileName: 'fascicolo.txt',
      mimeType: 'text/plain',
      content: Buffer.from(`fascicolo ${randomUUID()}`),
      expectedKey: 'farm_file',
    });
    await practices.addAttachment({
      tenantId: orgId,
      userId: people.farmer,
      practiceId,
      fileName: 'appunti.txt',
      mimeType: 'text/plain',
      content: Buffer.from(`appunti ${randomUUID()}`),
    });
    await createDocumentRequest(prisma, {
      tenantId: orgId,
      practiceId,
      expectedKey: 'organic_certificate',
      message: 'Serve il certificato biologico aggiornato',
      dueDate: '2026-12-15',
      actorUserId: people.admin,
      requesterOrgId: orgId,
      channel: 'dashboard',
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('lists the documents of the own open practices', async () => {
    const result = await practices.executeCommand(
      { type: 'LIST_PRACTICE_DOCUMENTS', payload: { name: null } },
      actor('farmer'),
    );
    expect(result.type).toBe('documents');
    if (result.type !== 'documents') return;
    expect(result.practices).toHaveLength(1);
    const [docs] = result.practices;
    expect(docs.expected.map((e) => [e.label, e.state])).toContainEqual([
      expect.any(String),
      'to_verify',
    ]);
    expect(docs.files.map((f) => f.fileName)).toEqual(['appunti.txt']);
    expect(docs.requests).toEqual([expect.objectContaining({ dueDate: '2026-12-15' })]);
    const text = formatPracticeCommandResult(result);
    expect(text).toContain(`📁 Domanda PAC ${run}`);
    expect(text).toContain('richiesto entro il 15/12/2026');
    expect(text).toContain('📎 appunti.txt');
  });

  it('finds a practice by name, and only among the own ones', async () => {
    const named = await practices.executeCommand(
      { type: 'LIST_PRACTICE_DOCUMENTS', payload: { name: `Domanda PAC ${run}` } },
      actor('farmer'),
    );
    expect(named.type).toBe('documents');
    const other = await practices.executeCommand(
      { type: 'LIST_PRACTICE_DOCUMENTS', payload: { name: `Domanda PAC ${run}` } },
      actor('neighbour'),
    );
    expect(other.type).toBe('not_found');
    const none = await practices.executeCommand(
      { type: 'LIST_PRACTICE_DOCUMENTS', payload: { name: null } },
      actor('neighbour'),
    );
    expect(none).toEqual({ type: 'documents', practices: [], more: 0 });
    expect(formatPracticeCommandResult(none)).toBe('📁 Non hai pratiche aperte con documenti.');
  });
});
