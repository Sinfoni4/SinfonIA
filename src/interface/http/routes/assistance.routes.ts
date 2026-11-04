import { z } from 'zod';

import {
  listAssistanceRequests,
  updateAssistanceRequest,
} from '../../../core/assistance/assistance.service.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type AssistanceRoutesDeps = { prisma: PrismaClient };

const ListQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ParamsSchema = z.object({ id: z.string().uuid() });

function sendError(reply: FastifyReply, err: unknown) {
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * «Parla con un operatore» (H10): the requests from the chat, taken in charge and closed by the
 * ADMINs and OPERATORs of the organization.
 */
export const assistanceRoutes: FastifyPluginCallback<AssistanceRoutesDeps> = (app, deps, done) => {
  app.get('/assistance', { config: { permission: 'assistance.manage' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'assistance.manage');
      const query = ListQuerySchema.parse(req.query);
      return reply.send(
        ok(
          await listAssistanceRequests(deps.prisma, {
            tenantId: grant.principal.tenantId,
            ...query,
          }),
        ),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  for (const action of ['take', 'close'] as const) {
    app.post(
      `/assistance/:id/${action}`,
      { config: { permission: 'assistance.manage' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'assistance.manage');
          const { id } = ParamsSchema.parse(req.params);
          const result = await updateAssistanceRequest(deps.prisma, {
            tenantId: grant.principal.tenantId,
            id,
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
