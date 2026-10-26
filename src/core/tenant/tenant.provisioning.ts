import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { registerInviteCode } from './tenant.invite.store.js';
import { uuidFromSeed } from './tenant.uuid.js';

export interface CreateTenantInput {
  name: string;
  module: string;
  integration?: {
    type: 'none' | 'external';
  };
}

export interface TenantProvisionResult {
  tenantId: string;
  inviteCode: string;
}

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  return prisma;
}

function generateTenantId(name: string): string {
  return uuidFromSeed(`tenant:${name}:${Date.now()}`);
}

function generateInviteCode(name: string): string {
  return (
    name.toLowerCase().replace(/\s+/g, '-').slice(0, 12) + '-' + Math.floor(Math.random() * 1000)
  );
}

export function provisionTenant(input: CreateTenantInput): TenantProvisionResult {
  const tenantId = generateTenantId(input.name);
  const inviteCode = generateInviteCode(input.name);
  registerInviteCode(inviteCode, tenantId);

  void getPrisma()
    .tenant.upsert({
      where: { id: tenantId },
      update: {
        name: input.name,
      },
      create: {
        id: tenantId,
        name: input.name,
      },
    })
    .then(() =>
      getPrisma().inviteCode.upsert({
        where: { code: inviteCode },
        update: { tenantId },
        create: {
          code: inviteCode,
          tenantId,
        },
      }),
    )
    .catch((err) => {
      console.error('❌ TENANT PROVISIONING DB ERROR', err);
    });

  console.log(`🏢 TENANT PROVISIONED — name=${input.name} id=${tenantId}`);

  console.log(`🔑 INVITE CODE GENERATED — ${inviteCode}`);

  return {
    tenantId,
    inviteCode,
  };
}
