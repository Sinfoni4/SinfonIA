import { z } from 'zod';

import { requireTenantId } from '../../data/guard/tenant.js';

import { TenantNotFoundError, TenantNotLinkedError } from './tenant.errors.js';

import type { TenantDTO } from '../../data/types/domain.js';
import type { PrismaLike } from '../../data/types/prisma.js';

export type IntegrationType = 'none' | 'external';
export type SchedulerFrequency = 'daily' | 'weekly' | 'monthly';

export type SchedulerTask = {
  type: 'EXPORT_PRACTICES';
  payload?: Record<string, unknown>;
};

export type Tenant = {
  id: string;
  name: string;
  module: string;
  integration: {
    type: IntegrationType;
  };
  scheduler: {
    enabled: boolean;
    frequency: SchedulerFrequency;
  };
  tasks?: SchedulerTask[];
};

export const defaultSchedulerTasks: SchedulerTask[] = [
  {
    type: 'EXPORT_PRACTICES',
    payload: {
      filter: { type: 'month' },
      send: true,
    },
  },
];

const SchedulerTaskSchema = z.object({
  type: z.literal('EXPORT_PRACTICES'),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const SchedulerTasksSchema = z.array(SchedulerTaskSchema);

function parseIntegrationType(value: string): IntegrationType {
  return value === 'external' ? 'external' : 'none';
}

function parseFrequency(value: string | null): SchedulerFrequency {
  return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : 'monthly';
}

export function toTenantConfig(dto: TenantDTO): Tenant {
  let tasks: SchedulerTask[] | undefined;
  if (dto.schedulerTasks !== null && dto.schedulerTasks !== undefined) {
    const parsed = SchedulerTasksSchema.safeParse(dto.schedulerTasks);
    if (parsed.success) {
      tasks = parsed.data;
    } else {
      console.warn(`⚠️ Invalid scheduler tasks for tenant=${dto.id}; using defaults`);
    }
  }

  return {
    id: dto.id,
    name: dto.name,
    module: dto.module,
    integration: { type: parseIntegrationType(dto.integrationType) },
    scheduler: {
      enabled: dto.schedulerEnabled,
      frequency: parseFrequency(dto.schedulerFrequency),
    },
    ...(tasks ? { tasks } : {}),
  };
}

export async function getTenantById(prisma: PrismaLike, tenantId: string): Promise<Tenant> {
  const row = await prisma.tenant.findUnique({ where: { id: requireTenantId(tenantId) } });
  if (!row) {
    throw new TenantNotFoundError();
  }
  return toTenantConfig(row);
}

export async function getTenantByUserAsync(prisma: PrismaLike, userId: string): Promise<Tenant> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { tenantId: true },
  });
  if (!user) {
    throw new TenantNotLinkedError();
  }
  return getTenantById(prisma, user.tenantId);
}

export async function getAllTenants(prisma: PrismaLike): Promise<Tenant[]> {
  const rows = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toTenantConfig);
}

export async function getTenantByTelegramUserAsync(
  prisma: PrismaLike,
  telegramId: string,
): Promise<{ tenant: Tenant; userId: string; role: 'ADMIN' | 'OPERATOR' | 'MEMBER' }> {
  const user = await prisma.user.findFirst({
    where: { telegramId: telegramId.trim() },
    orderBy: { createdAt: 'desc' },
    select: { id: true, tenantId: true, role: true },
  });
  if (!user) {
    throw new TenantNotLinkedError();
  }
  const tenant = await getTenantById(prisma, user.tenantId);
  return { tenant, userId: user.id, role: user.role };
}
