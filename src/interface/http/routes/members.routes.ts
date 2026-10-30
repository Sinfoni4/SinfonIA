import { z } from 'zod';

import {
  setScheduledExport,
  setTenantScope,
} from '../../../core/identity/member-access.service.js';
import {
  changeMemberRole,
  listMembers,
  reactivateMembership,
  revokeMembership,
} from '../../../core/identity/revocation.service.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { LoginService } from '../../../core/identity/login.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback } from 'fastify';

export type MembersRoutesDeps = { prisma: PrismaClient; login?: LoginService };

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

  done();
};
