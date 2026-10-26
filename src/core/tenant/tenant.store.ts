import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { getTenantIdByUser } from './tenant.invite.store.js';
import { uuidFromSeed } from './tenant.uuid.js';

type IntegrationType = 'none' | 'external';

export type SchedulerTask = {
  type: 'EXPORT_PRACTICES';
  payload?: Record<string, unknown>;
};

type Tenant = {
  id: string;
  module: string;
  integration?: {
    type: IntegrationType;
  };
  scheduler?: {
    enabled: boolean;
    frequency?: 'daily' | 'weekly' | 'monthly';
  };
  tasks?: SchedulerTask[];
  // Internal marker to surface silent fallback cases.
  _isFallback?: boolean;
};

/** Default when `tenant.tasks` is absent (safe MVP). */
export const defaultSchedulerTasks: SchedulerTask[] = [
  {
    type: 'EXPORT_PRACTICES',
    payload: {
      filter: { type: 'month' },
      send: true,
    },
  },
];

const tenants: Record<string, Tenant> = {
  default: {
    // Real UUID aligned with TelegramAdapter demo tenant (`uuidFromSeed('demo-tenant')`).
    id: uuidFromSeed('demo-tenant'),
    module: 'music',
    integration: { type: 'none' },
    scheduler: { enabled: true, frequency: 'monthly' },
  },
  tenant1: {
    id: uuidFromSeed('tenant-1'),
    module: 'music',
    integration: { type: 'none' },
    scheduler: { enabled: true, frequency: 'monthly' },
    tasks: [
      {
        type: 'EXPORT_PRACTICES',
        payload: {
          filter: { type: 'month' },
          send: true,
        },
      },
    ],
  },
  tenant2: {
    id: uuidFromSeed('tenant-2'),
    module: 'music',
    integration: { type: 'none' },
    scheduler: { enabled: false },
  },
  tenant3: {
    id: uuidFromSeed('tenant-3'),
    module: 'music',
    integration: { type: 'none' },
    scheduler: { enabled: true, frequency: 'weekly' },
    tasks: [
      {
        type: 'EXPORT_PRACTICES',
        payload: {
          filter: { type: 'month' },
          send: true,
        },
      },
      {
        type: 'EXPORT_PRACTICES',
        payload: {
          filter: { type: 'year', value: new Date().getFullYear() },
          send: true,
        },
      },
    ],
  },
  tenant4: {
    id: uuidFromSeed('tenant-4'),
    module: 'music',
    integration: { type: 'none' },
    scheduler: { enabled: true, frequency: 'daily' },
  },
};

const defaultTenant = tenants.default;

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  return prisma;
}

/** Read-only snapshot of configured tenants (in-memory MVP). */
export function getAllTenants(): readonly Tenant[] {
  return Object.values(tenants);
}

export function getTenantByUser(userId: string): Tenant {
  const tenantId = getTenantIdByUser(userId);
  if (tenantId) {
    return getTenantById(tenantId);
  }
  return defaultTenant;
}

export async function getTenantByUserAsync(userId: string): Promise<Tenant> {
  try {
    const record = await getPrisma().userTenant.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (record) {
      console.log(`🏢 TENANT RESOLUTION — user=${userId} source=db`);
      return getTenantById(record.tenantId);
    }

    console.warn(`⚠️ TENANT DEFAULT USED — user=${userId}`);
    return defaultTenant;
  } catch (err) {
    console.error('❌ TENANT RESOLUTION ERROR', err);
    console.warn(`⚠️ TENANT DEFAULT USED — user=${userId}`);
    return defaultTenant;
  }
}

export function getTenantById(tenantId: string): Tenant {
  const tenant = Object.values(tenants).find((t) => t.id === tenantId);

  if (tenant) {
    return tenant;
  }

  console.warn(`⚠️ TENANT NOT FOUND — id=${tenantId} → using default`);

  return {
    ...defaultTenant,
    _isFallback: true,
  };
}
