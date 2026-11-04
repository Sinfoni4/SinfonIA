import { z } from 'zod';

import { networkStats } from '../../../core/network/network-stats.service.js';
import {
  changeMembership,
  inviteMember,
  listMyNetworks,
  listNetworkMembers,
} from '../../../core/network/network.service.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type NetworkRoutesDeps = { prisma: PrismaClient };

const IdParamsSchema = z.object({ id: z.string().uuid() });
const InviteBodySchema = z.object({ orgId: z.string().trim().uuid() }).strict();
const StatsQuerySchema = z.object({
  period: z.enum(['month', 'quarter', 'year']).default('month'),
  previous: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

function sendError(reply: FastifyReply, err: unknown) {
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * MF9 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §1.2-§1.3, D4): the members of a network and
 * its aggregate statistics; the memberships of a company. No route here reads data of a member.
 */
export const networkRoutes: FastifyPluginCallback<NetworkRoutesDeps> = (app, deps, done) => {
  app.get('/network/members', { config: { permission: 'network.manage' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'network.manage');
      return reply.send(ok(await listNetworkMembers(deps.prisma, grant.principal.tenantId)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/network/members', { config: { permission: 'network.manage' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'network.manage');
      const body = InviteBodySchema.parse(req.body);
      const result = await inviteMember(deps.prisma, {
        networkId: grant.principal.tenantId,
        childOrgId: body.orgId,
        actorUserId: grant.principal.userId,
      });
      return reply.status(201).send(ok(result));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/network/members/:id/end',
    { config: { permission: 'network.manage' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'network.manage');
        const { id } = IdParamsSchema.parse(req.params);
        const result = await changeMembership(deps.prisma, {
          relationId: id,
          actorOrgId: grant.principal.tenantId,
          actorUserId: grant.principal.userId,
          action: 'end',
        });
        return reply.send(ok(result));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/network/stats', { config: { permission: 'network.stats' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'network.stats');
      const query = StatsQuerySchema.parse(req.query);
      return reply.send(
        ok(
          await networkStats(deps.prisma, {
            networkId: grant.principal.tenantId,
            actorUserId: grant.principal.userId,
            kind: query.period,
            previous: query.previous,
          }),
        ),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get('/memberships', { config: { permission: 'memberships.manage' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'memberships.manage');
      return reply.send(ok(await listMyNetworks(deps.prisma, grant.principal.tenantId)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  for (const action of ['confirm', 'refuse', 'leave'] as const) {
    app.post(
      `/memberships/:id/${action}`,
      { config: { permission: 'memberships.manage' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'memberships.manage');
          const { id } = IdParamsSchema.parse(req.params);
          const result = await changeMembership(deps.prisma, {
            relationId: id,
            actorOrgId: grant.principal.tenantId,
            actorUserId: grant.principal.userId,
            action,
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      },
    );
  }

  done();
};
