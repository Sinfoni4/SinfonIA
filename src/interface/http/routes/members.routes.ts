import { z } from 'zod';

import {
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  setMemberCustomRole,
  updateCustomRole,
} from '../../../core/authz/custom-roles.service.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../core/authz/permissions.js';
import {
  setScheduledExport,
  setTenantScope,
} from '../../../core/identity/member-access.service.js';
import { memberCard } from '../../../core/identity/member-card.service.js';
import {
  changeMemberRole,
  listMembers,
  reactivateMembership,
  revokeMembership,
} from '../../../core/identity/revocation.service.js';
import { NotFoundError } from '../../../data/errors/errors.js';
import { requirePermission, requirePrincipal } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { ChannelLinkService } from '../../../core/identity/channel-link.service.js';
import type { LoginService } from '../../../core/identity/login.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback } from 'fastify';

export type MembersRoutesDeps = {
  prisma: PrismaClient;
  login?: LoginService;
  /** AGX-10: verified chat links; absent where email login is off (nobody can link there). */
  channelLinks?: ChannelLinkService;
};

const ChannelParamsSchema = z.object({ id: z.string().uuid() });
const MemberChannelParamsSchema = z.object({
  userId: z.string().uuid(),
  linkId: z.string().uuid(),
});

const MemberParamsSchema = z.object({ userId: z.string().uuid() });
const RevokeBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});
const RoleBodySchema = z.object({ role: z.enum(['ADMIN', 'OPERATOR', 'MEMBER']) });
const PermissionBodySchema = z.object({
  permission: z.enum(['practice.export']),
  granted: z.boolean(),
});
const ScheduledExportBodySchema = z.object({ enabled: z.boolean() });
const InvitationBodySchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['ADMIN', 'OPERATOR', 'MEMBER']),
});
const InvitationParamsSchema = z.object({ invitationId: z.string().uuid() });

// B2: custom roles. Permissions only from the catalog; the service checks them on the base role.
const CustomPermissionsSchema = z
  .partialRecord(z.enum(PERMISSIONS), z.enum(['own', 'assigned', 'tenant']))
  .refine((p) => Object.keys(p).length <= PERMISSIONS.length);
const RoleIdParamsSchema = z.object({ roleId: z.string().uuid() });
const CreateRoleBodySchema = z
  .object({
    name: z.string().max(200),
    baseRole: z.enum(['ADMIN', 'OPERATOR', 'MEMBER']),
    permissions: CustomPermissionsSchema,
  })
  .strict();
const UpdateRoleBodySchema = z
  .object({ name: z.string().max(200).optional(), permissions: CustomPermissionsSchema.optional() })
  .strict();
const MemberRoleBodySchema = z.object({ roleId: z.string().uuid().nullable() }).strict();

/**
 * Members of the caller's organization, for its administrators (MF5): revocation takes effect at
 * the member's next request, on every channel.
 */
export const membersRoutes: FastifyPluginCallback<MembersRoutesDeps> = (app, deps, done) => {
  app.get('/members', { config: { permission: 'members.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'members.read').principal;
      return reply.send(ok(await listMembers(deps.prisma, auth.tenantId)));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.post(
    '/members/:userId/revoke',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        const { reason } = RevokeBodySchema.parse(req.body ?? {});
        await revokeMembership(deps.prisma, auth.tenantId, userId, { userId: auth.userId }, reason);
        return reply.send(ok({ userId, status: 'REVOKED' }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  app.post(
    '/members/:userId/reactivate',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        await reactivateMembership(deps.prisma, auth.tenantId, userId, { userId: auth.userId });
        return reply.send(ok({ userId, status: 'ACTIVE' }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // Role of a member, effective at the next request; never the last active ADMIN.
  app.post(
    '/members/:userId/role',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        const { role } = RoleBodySchema.parse(req.body);
        const { changed } = await changeMemberRole(deps.prisma, auth.tenantId, userId, role, {
          userId: auth.userId,
        });
        return reply.send(ok({ userId, role, changed }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // Organization-wide scope of a permission, where the catalog allows it (D5).
  app.post(
    '/members/:userId/permissions',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        const body = PermissionBodySchema.parse(req.body);
        await setTenantScope(deps.prisma, auth.tenantId, userId, body.permission, body.granted, {
          userId: auth.userId,
        });
        return reply.send(ok({ userId, permission: body.permission, granted: body.granted }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // Scheduled export in chat (D5b option b): on only by the person, off by the person or an ADMIN.
  app.post(
    '/members/:userId/scheduled-export',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        const { enabled } = ScheduledExportBodySchema.parse(req.body);
        await setScheduledExport(deps.prisma, auth.tenantId, userId, enabled, {
          userId: auth.userId,
        });
        return reply.send(ok({ userId, receivesScheduledExport: enabled }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // Named invitations (MF6), only when email login is enabled.
  const login = deps.login;
  if (login) {
    // Pending, accepted, revoked and expired invitations (B3); never the token.
    app.get(
      '/members/invitations',
      { config: { permission: 'members.read' } },
      async (req, reply) => {
        try {
          const auth = requirePermission(req, 'members.read').principal;
          return reply.send(ok(await login.listInvitations(auth.tenantId)));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );
    app.post(
      '/members/invitations',
      { config: { permission: 'members.manage' } },
      async (req, reply) => {
        try {
          const auth = requirePermission(req, 'members.manage').principal;
          const body = InvitationBodySchema.parse(req.body);
          const created = await login.createInvitation(auth.tenantId, body.email, body.role, {
            userId: auth.userId,
          });
          return reply.status(201).send(ok(created));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );
    app.post(
      '/members/invitations/:invitationId/revoke',
      { config: { permission: 'members.manage' } },
      async (req, reply) => {
        try {
          const auth = requirePermission(req, 'members.manage').principal;
          const { invitationId } = InvitationParamsSchema.parse(req.params);
          const revoked = await login.revokeInvitation(auth.tenantId, invitationId, {
            userId: auth.userId,
          });
          return revoked
            ? reply.send(ok({ invitationId, revoked: true }))
            : reply.status(404).send(fail('NOT_FOUND', 'Invitation not found'));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );
  }

  // Cantiere 3 (item 43): one member in one view, for the administrators.
  app.get('/members/:userId', { config: { permission: 'members.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'members.read').principal;
      const { userId } = MemberParamsSchema.parse(req.params);
      return reply.send(ok(await memberCard(deps.prisma, auth.tenantId, userId)));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // --- AGX-10 / MF7: chat links ----------------------------------------------------------------

  // One's own links (Telegram, WhatsApp), to see and revoke them from the profile.
  app.get('/me/channels', { config: { permission: 'authenticated' } }, async (req, reply) => {
    try {
      const auth = requirePrincipal(req);
      return reply.send(
        ok({
          links: deps.channelLinks ? await deps.channelLinks.list(auth.userId) : [],
          linkingAvailable: Boolean(deps.channelLinks),
        }),
      );
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.post(
    '/me/channels/:id/revoke',
    { config: { permission: 'authenticated' } },
    async (req, reply) => {
      try {
        const auth = requirePrincipal(req);
        const { id } = ChannelParamsSchema.parse(req.params);
        if (!deps.channelLinks) throw new NotFoundError('Link not found');
        await deps.channelLinks.revoke({
          identityId: id,
          ownerUserId: auth.userId,
          actor: { userId: auth.userId },
        });
        return reply.send(ok({ revoked: true }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // The links of a member, for the administrators: revoking one stops the bot recognizing it.
  app.get(
    '/members/:userId/channels',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        const member = await deps.prisma.membership.count({
          where: { userId, orgId: auth.tenantId },
        });
        if (member === 0) throw new NotFoundError('Member not found');
        return reply.send(ok(deps.channelLinks ? await deps.channelLinks.list(userId) : []));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  app.post(
    '/members/:userId/channels/:linkId/revoke',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId, linkId } = MemberChannelParamsSchema.parse(req.params);
        if (!deps.channelLinks) throw new NotFoundError('Link not found');
        await deps.channelLinks.revoke({
          identityId: linkId,
          ownerUserId: userId,
          actor: { userId: auth.userId, orgId: auth.tenantId },
        });
        return reply.send(ok({ revoked: true }));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // --- B2: custom roles --------------------------------------------------------------------

  // What each base role allows, to build a custom role from it.
  app.get('/roles/catalog', { config: { permission: 'members.manage' } }, async (req, reply) => {
    try {
      requirePermission(req, 'members.manage');
      return reply.send(ok(ROLE_PERMISSIONS));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.get('/roles', { config: { permission: 'members.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'members.read').principal;
      return reply.send(ok(await listCustomRoles(deps.prisma, auth.tenantId)));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.post('/roles', { config: { permission: 'members.manage' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'members.manage').principal;
      const body = CreateRoleBodySchema.parse(req.body);
      return reply
        .status(201)
        .send(
          ok(await createCustomRole(deps.prisma, auth.tenantId, body, { userId: auth.userId })),
        );
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.patch('/roles/:roleId', { config: { permission: 'members.manage' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'members.manage').principal;
      const { roleId } = RoleIdParamsSchema.parse(req.params);
      const body = UpdateRoleBodySchema.parse(req.body);
      return reply.send(
        ok(
          await updateCustomRole(deps.prisma, auth.tenantId, roleId, body, { userId: auth.userId }),
        ),
      );
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.delete('/roles/:roleId', { config: { permission: 'members.manage' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'members.manage').principal;
      const { roleId } = RoleIdParamsSchema.parse(req.params);
      await deleteCustomRole(deps.prisma, auth.tenantId, roleId, { userId: auth.userId });
      return reply.send(ok({ id: roleId, deleted: true }));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  app.post(
    '/members/:userId/custom-role',
    { config: { permission: 'members.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'members.manage').principal;
        const { userId } = MemberParamsSchema.parse(req.params);
        const { roleId } = MemberRoleBodySchema.parse(req.body);
        return reply.send(
          ok(
            await setMemberCustomRole(deps.prisma, auth.tenantId, userId, roleId, {
              userId: auth.userId,
            }),
          ),
        );
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  done();
};
