import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { MusicAdapter } from './music.adapter.js';

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  return prisma;
}

type ContextCacheEntry = {
  data: {
    recentPractices: Array<{ name: string }>;
    totalPractices: number;
  };
  timestamp: number;
};

const contextCache = new Map<string, ContextCacheEntry>();
const CONTEXT_TTL_MS = 5000;
const MAX_CACHE_SIZE = 100;

function invalidateContextCache(tenantId: string, userId: string): void {
  contextCache.delete(`${tenantId}:${userId}`);
}

type MusicPracticePayload = {
  type: 'music_practice';
  name: string;
};

function payloadName(payload: unknown): string | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'music_practice' &&
    'name' in payload &&
    typeof (payload as { name: unknown }).name === 'string'
  ) {
    return (payload as MusicPracticePayload).name;
  }

  return null;
}

export const internalMusicAdapter: MusicAdapter = {
  async createPractice(input) {
    const db = getPrisma();

    await db.practice.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        payload: {
          type: 'music_practice',
          name: input.name,
        },
      },
    });

    invalidateContextCache(input.tenantId, input.userId);

    return { success: true };
  },

  async listPractices(input) {
    const db = getPrisma();

    const practices = await db.practice.findMany({
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        payload: {
          path: ['type'],
          equals: 'music_practice',
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        payload: true,
        createdAt: true,
      },
    });

    const rows: Array<{ name: string; createdAt: Date }> = [];

    for (const record of practices) {
      const name = payloadName(record.payload);
      if (!name) continue;
      rows.push({
        name,
        createdAt: record.createdAt,
      });
    }

    return rows;
  },

  async deletePractice(input) {
    const db = getPrisma();

    const result = await db.practice.deleteMany({
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        AND: [
          {
            payload: {
              path: ['type'],
              equals: 'music_practice',
            },
          },
          {
            payload: {
              path: ['name'],
              equals: input.name,
            },
          },
        ],
      },
    });

    if (result.count > 0) {
      invalidateContextCache(input.tenantId, input.userId);
      return { success: true };
    }

    return { success: false };
  },

  async getContext(input) {
    const start = Date.now();

    try {
      const cacheKey = `${input.tenantId}:${input.userId}`;
      const cached = contextCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < CONTEXT_TTL_MS) {
        console.log('⚡ CONTEXT CACHE HIT — music');
        console.log(`📊 CONTEXT METRICS — module=music latency=${Date.now() - start}ms`);
        return cached.data;
      }

      const db = getPrisma();

      const practices = await db.practice.findMany({
        where: {
          tenantId: input.tenantId,
          userId: input.userId,
          payload: {
            path: ['type'],
            equals: 'music_practice',
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      const totalPractices = await db.practice.count({
        where: {
          tenantId: input.tenantId,
          userId: input.userId,
          payload: {
            path: ['type'],
            equals: 'music_practice',
          },
        },
      });

      const data = {
        recentPractices: practices
          .map((p) => payloadName(p.payload))
          .filter((name): name is string => name !== null && name.length > 0)
          .map((name) => ({ name })),
        totalPractices,
      };

      contextCache.set(cacheKey, { data, timestamp: Date.now() });

      if (contextCache.size > MAX_CACHE_SIZE) {
        const firstKey = contextCache.keys().next().value;
        if (firstKey !== undefined) {
          contextCache.delete(firstKey);
        }
      }

      console.log(`📊 CONTEXT METRICS — module=music latency=${Date.now() - start}ms`);
      return data;
    } catch (error) {
      console.error(`❌ CONTEXT ERROR — module=music latency=${Date.now() - start}ms`);
      console.error('❌ MUSIC MODULE CONTEXT ERROR', error);
      return {
        recentPractices: [],
        totalPractices: 0,
      };
    }
  },
};
