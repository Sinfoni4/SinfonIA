import { NotFoundError } from '../../data/errors/errors.js';

import type { PrismaLike } from '../../data/types/prisma.js';

export async function registerInviteCode(
  prisma: PrismaLike,
  code: string,
  tenantId: string,
): Promise<void> {
  await prisma.inviteCode.create({
    data: { code, tenantId },
  });
}

export async function getTenantIdByInvite(
  prisma: PrismaLike,
  code: string,
): Promise<string | null> {
  const record = await prisma.inviteCode.findUnique({ where: { code } });
  return record?.tenantId ?? null;
}

export async function bindUserToTenant(
  prisma: PrismaLike,
  userId: string,
  tenantId: string,
): Promise<void> {
  // MF12: belonging to the organization is the membership, not a column of the user.
  const membership = await prisma.membership.findFirst({
    where: { userId, orgId: tenantId },
    select: { id: true },
  });
  if (!membership) {
    throw new NotFoundError('User not found in tenant');
  }

  await prisma.userTenant.upsert({
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
  });
}
