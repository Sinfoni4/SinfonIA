import {
  findChannelMemberships,
  OrganizationChoiceRequiredError,
} from '../../core/identity/membership.service.js';
import { TenantNotLinkedError } from '../../core/tenant/tenant.errors.js';
import { getTenantById } from '../../core/tenant/tenant.store.js';

import type { ChannelIdentityProvider } from './conversation.service.js';
import type { ChannelType, PrismaClient } from '@prisma/client';

/**
 * Identity of chat users through channel identities and memberships (MF4), shared by Telegram and
 * WhatsApp. Linking a chat account is the verified procedure of AGX-10 (ChannelLinkService): the
 * permanent invite code of an organization no longer links anyone.
 */
export function createMembershipIdentityProvider(
  prisma: PrismaClient,
  channel: ChannelType,
): ChannelIdentityProvider {
  return {
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
        customPermissions: only.customPermissions,
      };
    },

    async tenantFor(tenantId) {
      return getTenantById(prisma, tenantId);
    },
  };
}
