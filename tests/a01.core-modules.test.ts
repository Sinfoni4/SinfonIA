/**
 * Phase 1 — Core and modules (docs/FASE1_CORE_E_MODULI.md):
 * A01 the Core does not grow new sector words; A02 the modules are data behind one contract;
 * A04/A05 kinds, fields and sub-states come from the module; A03 a function turned off is refused
 * in the backend on every channel, and its scheduled tasks do not run.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildInterpreterPrompt } from '../src/ai/interpreter/interpreter.prompt.js';
import { authorize, PermissionDeniedError } from '../src/core/authz/authorization.service.js';
import { PERMISSIONS } from '../src/core/authz/permissions.js';
import {
  FEATURE_PERMISSIONS,
  FEATURES,
  FeatureDisabledError,
  featureOf,
} from '../src/core/features/features.js';
import { MODULE_IDS } from '../src/core/modules/module.contract.js';
import { resolvePracticeCreation } from '../src/core/practice/practice-module.js';
import { readPracticePayload } from '../src/core/practice/practice.payload.js';
import { SchedulerService } from '../src/core/scheduler/scheduler.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { ConversationService } from '../src/interface/conversation/conversation.service.js';
import { executeComplianceCommand } from '../src/interface/telegram/compliance.command.js';
import { mapTelegramErrorToMessage } from '../src/interface/telegram/telegram.errors.js';
import { getModule, MODULES, PRACTICE_KINDS } from '../src/modules/registry.js';

import type { SchedulerTaskHandler } from '../src/core/scheduler/scheduler.tasks.js';
import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { PrismaClient } from '@prisma/client';

const SRC = path.resolve(__dirname, '../src');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('A01/A02: the Core and the modules', () => {
  it('lists every kind of every module, and no other', () => {
    const declared = Object.values(MODULES).flatMap((m) => m.practiceTypes.map((t) => t.kind));
    expect([...new Set(declared)].sort()).toEqual([...PRACTICE_KINDS].sort());
    expect(Object.keys(MODULES).sort()).toEqual([...MODULE_IDS].sort());
    for (const module of Object.values(MODULES)) {
      expect(module.practiceTypes.map((t) => t.kind)).toContain(module.defaultKind);
    }
  });

  it('keeps the modules as data: they import only the contract and each other', () => {
    for (const file of filesUnder(path.join(SRC, 'modules'))) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(
          spec.startsWith('./') ||
            spec === '../core/modules/module.contract.js' ||
            spec === '@prisma/client',
          `${path.basename(file)} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('does not let new sector words into the Core (A01 inventory)', () => {
    // What is still there, with the reason: docs/FASE1_CORE_E_MODULI.md §1.
    const allowed = new Map<string, number>([
      ['core/modules/module.contract.ts', 2], // the list of module ids
      ['core/practice/practice.payload.ts', 4], // stored payload types and legacy `artistName`
      ['core/practice/practice.commands.ts', 2], // comment
      ['core/tenant/tenant.provisioning.ts', 1], // default module of old seeds
    ]);
    const found = new Map<string, number>();
    for (const file of filesUnder(path.join(SRC, 'core'))) {
      const count = (readFileSync(file, 'utf8').match(/music|artist|🎵/gi) ?? []).length;
      if (count > 0) found.set(path.relative(SRC, file).replace(/\\/g, '/'), count);
    }
    for (const [file, count] of found) {
      expect(count, file).toBeLessThanOrEqual(allowed.get(file) ?? 0);
    }
  });

  it('falls back to the generic module for an unknown value', () => {
    expect(getModule('space').id).toBe('generic');
    expect(getModule(null).id).toBe('generic');
  });
});

describe('A04/A05: kinds, fields and sub-states from the module', () => {
  it('uses the default kind of the module and refuses kinds of other modules', () => {
    expect(resolvePracticeCreation(getModule('music'), {}).kind).toBe('music');
    expect(resolvePracticeCreation(getModule('agri'), {}).kind).toBe('agri');
    expect(resolvePracticeCreation(getModule('music'), { kind: 'generic' }).kind).toBe('generic');
    expect(() => resolvePracticeCreation(getModule('music'), { kind: 'agri' })).toThrow(
      /non fa parte del modulo/,
    );
    expect(() => resolvePracticeCreation(getModule('generic'), { kind: 'artist' })).toThrow();
  });

  it('checks the fields against their definition', () => {
    const agri = getModule('agri');
    expect(
      resolvePracticeCreation(agri, {
        kind: 'agri',
        fields: { procedure: 'organic', dueDate: '2027-03-31' },
      }).fields,
    ).toEqual({ procedure: 'organic', dueDate: '2027-03-31' });
    for (const fields of [
      { procedure: 'lottery' },
      { campaignYear: '2027' },
      { dueDate: '31/03/2027' },
      { unknown: true },
    ]) {
      expect(() => resolvePracticeCreation(agri, { kind: 'agri', fields })).toThrow(
        /Campi non validi/,
      );
    }
  });

  it('reads labels and summaries from the module, and old payloads as before', () => {
    expect(readPracticePayload({ type: 'agri_practice', name: 'PAC' })).toMatchObject({
      kind: 'agri',
      typeLabel: 'agricultural practice',
      summary: 'pratica agricola PAC',
    });
    expect(readPracticePayload({ type: 'artist_practice', name: 'Mario' }).summary).toBe(
      'pratica artista Mario',
    );
    expect(readPracticePayload({ artistName: 'Vecchia' })).toMatchObject({
      kind: 'legacy',
      name: 'Vecchia',
    });
    expect(readPracticePayload({ type: 'boat_practice', name: 'X' }).kind).toBe('unknown');
  });

  it('gives the AI the sector of the module, never personal data', () => {
    const prompt = buildInterpreterPrompt('crea pratica', {
      tenantId: 't',
      sector: getModule('agri').aiInstructions,
    });
    expect(prompt).toContain('SECTOR CONTEXT');
    expect(prompt).toContain('domande PAC');
    expect(buildInterpreterPrompt('crea pratica', { tenantId: 't' })).not.toContain(
      'SECTOR CONTEXT',
    );
  });
});

describe('A03: functions turned off for an organization', () => {
  it('covers only permissions of the catalog, each in one function', () => {
    const covered = FEATURES.flatMap((f) => FEATURE_PERMISSIONS[f]);
    expect(new Set(covered).size).toBe(covered.length);
    for (const p of covered) expect(PERMISSIONS).toContain(p);
    // The Core is never turned off.
    for (const p of ['practice.create', 'practice.read', 'members.manage', 'audit.read'] as const) {
      expect(featureOf(p)).toBeUndefined();
    }
  });

  it('refuses the permissions of a function turned off, for every role, after the role check', () => {
    const principal = {
      tenantId: 't',
      userId: 'u',
      role: 'ADMIN' as const,
      disabledFeatures: ['deadlines'],
    };
    expect(() => authorize(principal, 'compliance.manage')).toThrow(FeatureDisabledError);
    expect(authorize(principal, 'practice.create').scope).toBe('own');
    // A role without the permission still gets the role refusal.
    expect(() =>
      authorize({ ...principal, role: 'MEMBER', disabledFeatures: [] }, 'compliance.manage'),
    ).toThrow(PermissionDeniedError);
    expect(
      mapTelegramErrorToMessage(new FeatureDisabledError('deadlines', 'compliance.read')),
    ).toBe('ℹ️ Questa funzione non è attiva per la tua organizzazione.');
  });

  it('turns off the AI, documents and deadlines in the chat', async () => {
    const tenant = {
      id: 't-1',
      name: 'Azienda',
      module: 'agri',
      disabledFeatures: ['ai_chat', 'documents', 'assistance'],
    } as unknown as Tenant;
    const handleMessage = vi.fn().mockResolvedValue('risposta AI');
    const requestAssistance = vi.fn();
    const service = new ConversationService(
      { practiceService: { executeCommand: vi.fn() }, handleMessage, requestAssistance },
      {
        name: 'telegram',
        identity: {
          link: () => Promise.resolve(null),
          resolve: () => Promise.resolve({ tenant, userId: 'u-1', role: 'ADMIN' }),
        },
      },
    );
    const replies: string[] = [];
    const send = (text: string, file?: object) =>
      service.handle({ senderId: '1', text, ...(file ? { file } : {}) } as never, (t) => {
        replies.push(t);
        return Promise.resolve();
      });
    await send('quante pratiche ho aperto questo mese?');
    expect(handleMessage).not.toHaveBeenCalled();
    expect(replies.at(-1)).toContain("L'assistente IA non è attivo");
    await send('', { fileName: 'a.pdf', mimeType: 'application/pdf', download: vi.fn() });
    expect(replies.at(-1)).toContain('non è attiva');
    await send('operatore');
    expect(requestAssistance).not.toHaveBeenCalled();
    expect(replies.at(-1)).toContain('non è attiva');

    const listDeadlines = vi.fn();
    const reply = await executeComplianceCommand(
      { type: 'LIST_DEADLINES' },
      {
        complianceService: { listDeadlines, createDeadline: vi.fn(), closeDeadline: vi.fn() },
        tenantId: 't-1',
        userId: 'u-1',
        role: 'ADMIN',
        disabledFeatures: ['deadlines'],
      },
    );
    expect(reply).toContain('non è attiva');
    expect(listDeadlines).not.toHaveBeenCalled();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('A03 with PostgreSQL', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('accepts only known function names in the database', async () => {
    const id = (await new TenantRepository(prisma).createTenant({ name: `a03-${randomUUID()}` }))
      .id;
    await expect(
      prisma.tenant.update({ where: { id }, data: { disabledFeatures: ['teleport'] } }),
    ).rejects.toThrow();
  });

  it('does not run the scheduled tasks of a function turned off', async () => {
    const id = (
      await new TenantRepository(prisma).createTenant({
        name: `a03-sched-${randomUUID()}`,
        schedulerEnabled: true,
        schedulerFrequency: 'daily',
      })
    ).id;
    await prisma.tenant.update({
      where: { id },
      data: { disabledFeatures: ['exports', 'delegations'] },
    });
    const ran: string[] = [];
    const handler = (type: SchedulerTaskHandler['type']): SchedulerTaskHandler => ({
      type,
      run: () => {
        ran.push(type);
        return Promise.resolve({});
      },
    });
    const scheduler = new SchedulerService(
      prisma,
      { exportPractices: vi.fn() },
      {
        handlers: [
          handler('EXPORT_PRACTICES'),
          handler('CHECK_COMPLIANCE_DEADLINES'),
          handler('CHECK_GRANT_EXPIRY'),
        ],
      },
    );
    const result = await scheduler.tick(new Date('2031-01-15T10:00:00Z'), id);
    expect(ran).toEqual(['CHECK_COMPLIANCE_DEADLINES']);
    expect(result).toEqual({ triggeredCount: 1, skippedCount: 2 });
  });
});
