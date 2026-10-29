import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import {
  InMemoryConversationMemory,
  PrismaConversationMemory,
} from '../src/interface/conversation/conversation.memory.js';

import type { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = describe.runIf(Boolean(DATABASE_URL));

describe('in-memory conversation memory', () => {
  it('remembers the last practice and welcomes once', async () => {
    const memory = new InMemoryConversationMemory();
    expect(await memory.getLastPractice('u1')).toBeNull();
    await memory.setLastPractice('t1', 'u1', 'p1');
    expect(await memory.getLastPractice('u1')).toBe('p1');
    expect(await memory.markOnboarded('t1', 'u1')).toBe(true);
    expect(await memory.markOnboarded('t1', 'u1')).toBe(false);
    await memory.reset('u1');
    expect(await memory.getLastPractice('u1')).toBeNull();
  });
});

describeWithDb('conversation memory on PostgreSQL (Step 8)', () => {
  let prisma: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    tenantId = (
      await new TenantRepository(prisma).createTenant({ name: `t-memory-${randomUUID()}` })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newUser() {
    return (
      await new UserRepository(prisma).createUser(tenantId, {
        email: `${randomUUID()}@memory.local`,
      })
    ).id;
  }

  it('keeps the last practice across a restart and between instances', async () => {
    const userId = await newUser();
    const practiceId = randomUUID();
    await new PrismaConversationMemory(prisma).setLastPractice(tenantId, userId, practiceId);

    const prisma2 = createPrismaClient(DATABASE_URL!);
    try {
      expect(await new PrismaConversationMemory(prisma2).getLastPractice(userId)).toBe(practiceId);
    } finally {
      await prisma2.$disconnect();
    }
  });

  it('welcomes a user exactly once, even with concurrent messages', async () => {
    const userId = await newUser();
    const prisma2 = createPrismaClient(DATABASE_URL!);
    try {
      const results = await Promise.all([
        new PrismaConversationMemory(prisma).markOnboarded(tenantId, userId),
        new PrismaConversationMemory(prisma2).markOnboarded(tenantId, userId),
        new PrismaConversationMemory(prisma).markOnboarded(tenantId, userId),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await new PrismaConversationMemory(prisma).markOnboarded(tenantId, userId)).toBe(
        false,
      );
    } finally {
      await prisma2.$disconnect();
    }
  });

  it('welcomes a user who already has a remembered practice', async () => {
    const userId = await newUser();
    const memory = new PrismaConversationMemory(prisma);
    await memory.setLastPractice(tenantId, userId, randomUUID());
    expect(await memory.markOnboarded(tenantId, userId)).toBe(true);
    expect(await memory.markOnboarded(tenantId, userId)).toBe(false);
  });

  it('forgets everything on reset', async () => {
    const userId = await newUser();
    const memory = new PrismaConversationMemory(prisma);
    await memory.setLastPractice(tenantId, userId, randomUUID());
    await memory.markOnboarded(tenantId, userId);
    await memory.reset(userId);
    expect(await memory.getLastPractice(userId)).toBeNull();
    expect(await memory.markOnboarded(tenantId, userId)).toBe(true);
  });
});
