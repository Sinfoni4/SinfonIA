import {
  findChannelMemberships,
  joinWithLegacyInvite,
  OrganizationChoiceRequiredError,
} from '../../core/identity/membership.service.js';
import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { bindUserToTenant, getTenantIdByInvite } from '../../core/tenant/tenant.invite.store.js';
import { getTenantById } from '../../core/tenant/tenant.store.js';

import type { ChannelIdentityProvider } from './conversation.service.js';
import type { ChannelType, PrismaClient } from '@prisma/client';

/**
 * Identity of chat users through channel identities and memberships (MF4), shared by Telegram and
 * WhatsApp. `createLegacyUser` makes the account of a chat user seen for the first time with an
 * invite code (the legacy procedure, until the verified linking of MF7).
 */
export function createMembershipIdentityProvider(
  prisma: PrismaClient,
  channel: ChannelType,
  createLegacyUser: (tenantId: string, senderId: string) => Promise<{ userId: string }>,
): ChannelIdentityProvider {
  return {
    async link(inviteCode, senderId) {
      const tenantId = await getTenantIdByInvite(prisma, inviteCode);
      if (!tenantId) return null;
      const linked = await prisma.channelIdentity.findFirst({
        where: { channel, externalId: senderId.trim(), revokedAt: null },
        select: { userId: true, user: { select: { status: true } } },
      });
      if (linked) {
        // A disabled person, or a revoked membership, is never reactivated by an invite code.
        if (linked.user.status !== 'ACTIVE') return null;
        // Same person in another organization: one more membership, not a second account.
        return (await joinWithLegacyInvite(prisma, tenantId, linked.userId)) ? tenantId : null;
      }
      const { userId } = await createLegacyUser(tenantId, senderId);
      await bindUserToTenant(prisma, userId, tenantId);
      return tenantId;
    },

    async resolve(senderId) {
      const found = await findChannelMemberships(prisma, channel, senderId);
      if (!found || found.options.length === 0) throw new TenantNotLinkedError();
      if (found.options.length > 1) {
        throw new OrganizationChoiceRequiredError(found.userId, found.options);
      }
      const only = found.options[0];
      return {
        tenant: await getTenantById(prisma, only.tenantId),
        userId: found.userId,
        role: only.role,
      };
    },

    async tenantFor(tenantId) {
      return getTenantById(prisma, tenantId);
    },
  };
}
