import { randomUUID } from 'node:crypto';

import { DatabaseError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike } from '../types/prisma.js';
import type { UserRole } from '@prisma/client';

/** Digits only: "+39 333 123 4567" and "393331234567" are the same number. */
export function normalizePhoneNumber(raw: string): string {
  return raw.replace(/\D/g, '');
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export class WhatsappIdentityRepository {
  constructor(private readonly prisma: PrismaLike) {}

  /**
   * Returns the user linked to this phone number in the tenant, creating a MEMBER user and the
   * link on first contact (the WhatsApp counterpart of an invite accepted on Telegram).
   */
  async ensureLinkedUser(tenantId: string, phone: string): Promise<{ userId: string }> {
    requireTenantId(tenantId);
    const phoneNumber = normalizePhoneNumber(phone);
    if (phoneNumber.length < 6) {
      throw new DatabaseError('A valid phone number is required');
    }

    const existing = await this.prisma.whatsappIdentity.findFirst({
      where: { tenantId, phoneNumber },
      select: { userId: true },
    });
    if (existing) return existing;

    if (!('$transaction' in this.prisma)) {
      throw new DatabaseError('ensureLinkedUser requires a root Prisma client');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            tenantId,
            email: `whatsapp-${randomUUID()}@local.invalid`,
            role: 'MEMBER',
          },
        });
        await tx.whatsappIdentity.create({ data: { tenantId, userId: user.id, phoneNumber } });
        return { userId: user.id };
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // Linked concurrently by another request.
        const linked = await this.prisma.whatsappIdentity.findFirst({
          where: { tenantId, phoneNumber },
          select: { userId: true },
        });
        if (linked) return linked;
      }
      throw new DatabaseError('Failed to link WhatsApp number', err);
    }
  }

  /** The most recent link of a phone number (a number may be linked in several tenants). */
  async findLatestByPhone(
    phone: string,
  ): Promise<{ tenantId: string; userId: string; role: UserRole } | null> {
    try {
      const row = await this.prisma.whatsappIdentity.findFirst({
        where: { phoneNumber: normalizePhoneNumber(phone) },
        orderBy: { createdAt: 'desc' },
        select: { tenantId: true, userId: true, user: { select: { role: true } } },
      });
      return row ? { tenantId: row.tenantId, userId: row.userId, role: row.user.role } : null;
    } catch (err: unknown) {
      throw new DatabaseError('Failed to find WhatsApp identity', err);
    }
  }
}
