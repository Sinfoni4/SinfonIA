import { randomBytes } from 'node:crypto';

import { TenantRepository } from '../../data/repositories/tenant.repository.js';
import { UserRepository } from '../../data/repositories/user.repository.js';

import { bindUserToTenant, registerInviteCode } from './tenant.invite.store.js';

import type { SchedulerFrequency, SchedulerTask } from './tenant.store.js';
import type { PrismaClient } from '@prisma/client';

export interface CreateTenantInput {
  name: string;
  module?: string;
  integration?: {
    type: 'none' | 'external';
  };
  scheduler?: {
    enabled: boolean;
    frequency?: SchedulerFrequency;
    tasks?: SchedulerTask[];
  };
  adminEmail?: string;
  adminTelegramId?: string;
}

export interface TenantProvisionResult {
  tenantId: string;
  inviteCode: string;
  adminUserId: string;
}

function generateInviteCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12);
  return `${slug || 'tenant'}-${randomBytes(8).toString('hex')}`;
}

export async function provisionTenant(
  prisma: PrismaClient,
  input: CreateTenantInput,
): Promise<TenantProvisionResult> {
  return prisma.$transaction(async (tx) => {
    const tenantRepo = new TenantRepository(tx);
    const userRepo = new UserRepository(tx);

    const tenant = await tenantRepo.createTenant({
      name: input.name,
      module: input.module ?? 'music',
      integrationType: input.integration?.type ?? 'none',
      schedulerEnabled: input.scheduler?.enabled ?? false,
      schedulerFrequency: input.scheduler?.frequency ?? null,
      schedulerTasks: input.scheduler?.tasks ?? null,
    });
    const tenantId = tenant.id;

    const inviteCode = generateInviteCode(input.name);
    await registerInviteCode(tx, inviteCode, tenantId);

    const admin = await userRepo.createUser(tenantId, {
      email: input.adminEmail ?? `admin-${tenantId}@local.invalid`,
      role: 'ADMIN',
      telegramId: input.adminTelegramId ?? null,
    });
    await bindUserToTenant(tx, admin.id, tenantId);

    return { tenantId, inviteCode, adminUserId: admin.id };
  });
}
