import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const inviteMap = new Map<string, string>();
const userTenantMap = new Map<string, string>();

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  return prisma;
}

export function registerInviteCode(code: string, tenantId: string) {
  inviteMap.set(code, tenantId);

  void getPrisma()
    .inviteCode.upsert({
      where: { code },
      update: { tenantId },
      create: { code, tenantId },
    })
    .catch((err) => {
      console.error('❌ INVITE STORE DB ERROR (registerInviteCode)', err);
    });
}

export function getTenantIdByInvite(code: string): string | null {
  const inMemory = inviteMap.get(code) ?? null;
  if (inMemory) return inMemory;

  void getPrisma()
    .inviteCode.findUnique({ where: { code } })
    .then((record) => {
      if (record) {
        inviteMap.set(code, record.tenantId);
      }
    })
    .catch((err) => {
      console.error('❌ INVITE STORE DB ERROR (getTenantIdByInvite)', err);
    });

  return null;
}

export function bindUserToTenant(userId: string, tenantId: string) {
  userTenantMap.set(userId, tenantId);

  void getPrisma()
    .userTenant.upsert({
      where: {
        userId_tenantId: {
          userId,
          tenantId,
        },
      },
      update: {},
      create: {
        userId,
        tenantId,
      },
    })
    .catch((err) => {
      console.error('❌ INVITE STORE DB ERROR (bindUserToTenant)', err);
    });
}

export function getTenantIdByUser(userId: string): string | null {
  const inMemory = userTenantMap.get(userId) ?? null;
  if (inMemory) {
    return inMemory;
  }

  void getPrisma()
    .userTenant.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    .then((record) => {
      if (record) {
        userTenantMap.set(userId, record.tenantId);
      }
    })
    .catch((err) => {
      console.error('❌ INVITE STORE DB ERROR (getTenantIdByUser)', err);
    });

  return null;
}
