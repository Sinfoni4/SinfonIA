/**
 * A practice created by the AI takes the default kind of the organization's module. A fixed kind of
 * the music module was refused by every other module (KIND_NOT_IN_MODULE), and the prompt and the
 * replies must not speak of an "artista" outside that sector.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ExecutorService } from '../src/ai/execution/executor.service.js';
import { buildInterpreterPrompt } from '../src/ai/interpreter/interpreter.prompt.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import { formatTelegramResponse } from '../src/interface/telegram/telegram.formatter.js';

import type { PrismaClient } from '@prisma/client';

describe('AI practice creation without a fixed kind', () => {
  it('lets the module choose the kind', async () => {
    const createPractice = vi.fn().mockResolvedValue({ id: 'p-1' });
    const executor = new ExecutorService({
      practiceService: { createPractice, transitionPractice: vi.fn() },
    });
    const res = await executor.execute(
      { action: 'create_practice', data: { artistName: ' PSR 2026 ' } },
      {
        tenantId: '550e8400-e29b-41d4-a716-446655440001',
        userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        role: 'ADMIN',
        customPermissions: null,
      },
    );
    expect(res.success).toBe(true);
    expect(createPractice).toHaveBeenCalledWith({
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      name: 'PSR 2026',
    });
  });

  it('tells the model the field is the practice name, not an artist', () => {
    const prompt = buildInterpreterPrompt('crea una pratica');
    expect(prompt).toContain('artistName = practice name');
    expect(prompt).toContain('Never call it "artista"');
    expect(prompt).not.toContain('artistName = person name');
  });

  it('does not answer "pratica per artista" when the name is missing', () => {
    const reply = formatTelegramResponse({
      input: 'crea pratica',
      command: { action: 'create_practice', data: {} },
      result: { success: true, result: {} },
    });
    expect(reply).toContain('Ho creato la pratica');
    expect(reply).not.toMatch(/artista/i);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('AI practice creation on PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it.each([
    ['agri', 'agri'],
    ['generic', 'generic'],
    ['music', 'music'],
  ])('creates the default kind of the %s module', async (module, kind) => {
    const orgId = (
      await new TenantRepository(prisma).createTenant({ name: `ai-kind-${module}-${run}`, module })
    ).id;
    const userId = (
      await new UserRepository(prisma).createUser(orgId, {
        email: `admin-${module}-${run}@ai-kind.local`,
        role: 'ADMIN',
      })
    ).id;
    const executor = new ExecutorService({
      practiceService: new PracticeApplicationService(prisma),
    });

    const res = await executor.execute(
      { action: 'create_practice', data: { artistName: `Vigneto ${run}` } },
      { tenantId: orgId, userId, role: 'ADMIN', customPermissions: null },
    );

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.result).toMatchObject({ name: `Vigneto ${run}`, kind });
    }
  });
});
