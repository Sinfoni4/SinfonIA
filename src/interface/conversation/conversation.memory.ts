import { Prisma } from '@prisma/client';

import type { PrismaLike } from '../../data/types/prisma.js';

/**
 * What the assistant remembers about a chat user between messages: the last practice they worked
 * on ("completa quella") and whether they have already been welcomed.
 */
export interface ConversationMemory {
  getLastPractice(userId: string): Promise<string | null>;
  setLastPractice(tenantId: string, userId: string, practiceId: string): Promise<void>;
  /** Records the welcome; true only the first time, even with concurrent messages. */
  markOnboarded(tenantId: string, userId: string): Promise<boolean>;
  reset(userId: string): Promise<void>;
  /** Organization chosen by a person who belongs to several (MF4). */
  getActiveOrg(userId: string): Promise<string | null>;
  /** Switching organization also forgets the last practice, which belonged to the old one. */
  setActiveOrg(userId: string, tenantId: string): Promise<void>;
  /** AGX-01: the file waiting for the person's answer, as stored (checked by the reader). */
  getPendingFile(userId: string): Promise<unknown>;
  /** Stores the waiting file, or removes it with null. */
  setPendingFile(tenantId: string, userId: string, value: object | null): Promise<void>;
}

/** Process memory: for tests and single-process development. Lost on restart. */
export class InMemoryConversationMemory implements ConversationMemory {
  private readonly lastPractice = new Map<string, string>();
  private readonly onboarded = new Set<string>();
  private readonly activeOrg = new Map<string, string>();
  private readonly pendingFile = new Map<string, object>();

  getLastPractice(userId: string): Promise<string | null> {
    return Promise.resolve(this.lastPractice.get(userId) ?? null);
  }

  setLastPractice(_tenantId: string, userId: string, practiceId: string): Promise<void> {
    this.lastPractice.set(userId, practiceId);
    return Promise.resolve();
  }

  markOnboarded(_tenantId: string, userId: string): Promise<boolean> {
    if (this.onboarded.has(userId)) return Promise.resolve(false);
    this.onboarded.add(userId);
    return Promise.resolve(true);
  }

  reset(userId: string): Promise<void> {
    this.lastPractice.delete(userId);
    this.onboarded.delete(userId);
    this.activeOrg.delete(userId);
    this.pendingFile.delete(userId);
    return Promise.resolve();
  }

  getPendingFile(userId: string): Promise<unknown> {
    return Promise.resolve(this.pendingFile.get(userId) ?? null);
  }

  setPendingFile(_tenantId: string, userId: string, value: object | null): Promise<void> {
    if (value) this.pendingFile.set(userId, value);
    else this.pendingFile.delete(userId);
    return Promise.resolve();
  }

  getActiveOrg(userId: string): Promise<string | null> {
    return Promise.resolve(this.activeOrg.get(userId) ?? null);
  }

  setActiveOrg(userId: string, tenantId: string): Promise<void> {
    if (this.activeOrg.get(userId) !== tenantId) this.lastPractice.delete(userId);
    this.activeOrg.set(userId, tenantId);
    return Promise.resolve();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

/** Database memory (conversation_state): survives restarts and is shared by all instances. */
export class PrismaConversationMemory implements ConversationMemory {
  constructor(private readonly prisma: PrismaLike) {}

  async getLastPractice(userId: string): Promise<string | null> {
    const row = await this.prisma.conversationState.findUnique({
      where: { userId },
      select: { lastPracticeId: true },
    });
    return row?.lastPracticeId ?? null;
  }

  async setLastPractice(tenantId: string, userId: string, practiceId: string): Promise<void> {
    await this.prisma.conversationState.upsert({
      where: { userId },
      create: { userId, tenantId, lastPracticeId: practiceId },
      update: { lastPracticeId: practiceId },
    });
  }

  async markOnboarded(tenantId: string, userId: string): Promise<boolean> {
    const now = new Date();
    // Only one of several concurrent messages can switch onboarded_at from null.
    const { count } = await this.prisma.conversationState.updateMany({
      where: { userId, onboardedAt: null },
      data: { onboardedAt: now },
    });
    if (count === 1) return true;
    try {
      await this.prisma.conversationState.create({ data: { userId, tenantId, onboardedAt: now } });
      return true;
    } catch (err: unknown) {
      // The row exists: already onboarded, or created by a concurrent message.
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async reset(userId: string): Promise<void> {
    await this.prisma.conversationState.deleteMany({ where: { userId } });
  }

  // conversation_state.tenant_id is the organization the person works in.
  async getActiveOrg(userId: string): Promise<string | null> {
    const row = await this.prisma.conversationState.findUnique({
      where: { userId },
      select: { tenantId: true },
    });
    return row?.tenantId ?? null;
  }

  async setActiveOrg(userId: string, tenantId: string): Promise<void> {
    await this.prisma.conversationState.upsert({
      where: { userId },
      create: { userId, tenantId },
      update: { tenantId, lastPracticeId: null },
    });
  }

  async getPendingFile(userId: string): Promise<unknown> {
    const row = await this.prisma.conversationState.findUnique({
      where: { userId },
      select: { pendingFile: true },
    });
    return row?.pendingFile ?? null;
  }

  async setPendingFile(tenantId: string, userId: string, value: object | null): Promise<void> {
    const pendingFile = value ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
    if (!value) {
      // Nothing to remove when the person has no conversation row yet.
      await this.prisma.conversationState.updateMany({ where: { userId }, data: { pendingFile } });
      return;
    }
    // The active organization (tenant_id) is never changed here.
    await this.prisma.conversationState.upsert({
      where: { userId },
      create: { userId, tenantId, pendingFile },
      update: { pendingFile },
    });
  }
}
