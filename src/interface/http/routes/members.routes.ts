import { z } from 'zod';

import {
  setScheduledExport,
  setTenantScope,
} from '../../../core/identity/member-access.service.js';
import {
  listMembers,
  reactivateMembership,
  revokeMembership,
} from '../../../core/identity/revocation.service.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback } from 'fastify';

export type MembersRoutesDeps = { prisma: PrismaClient };

const MemberParamsSchema = z.object({ userId: z.string().uuid() });
const RevokeBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});
const PermissionBodySchema = z.object({
  permission: z.enum(['practice.export']),
  granted: z.boolean(),
});
const ScheduledExportBodySchema = z.object({ enabled: z.boolean() });

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

  done();
};
