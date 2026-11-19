import { z } from 'zod';

import { scopedUserId } from '../../../core/authz/authorization.service.js';
import {
  listReviewQueue,
  validateAttachment,
} from '../../../core/practice/attachment-validation.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type AttachmentReviewRoutesDeps = { prisma: PrismaClient };

const QueueQuerySchema = z.object({
  status: z.enum(['to_review', 'validated', 'all']).default('to_review'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ParamsSchema = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

/** A1: the data of a document as a person confirms or corrects it (also used by AGX-04). */
export const ValidationBodySchema = z
  .object({
    documentType: z.string().max(40),
    fields: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.null()])),
  })
  .strict();

function sendError(reply: FastifyReply, err: unknown) {
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * A1 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.2, H9): the documents waiting for a person, and
 * the confirmation or correction of their data. ADMIN and OPERATOR work on the organization, a
 * MEMBER on their own practices.
 */
export const attachmentReviewRoutes: FastifyPluginCallback<AttachmentReviewRoutesDeps> = (
  app,
  deps,
  done,
) => {
  app.get(
    '/attachments/review',
    { config: { permission: 'attachment.validate' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'attachment.validate');
        const query = QueueQuerySchema.parse(req.query);
        const queue = await listReviewQueue(deps.prisma, {
          tenantId: grant.principal.tenantId,
          ownerUserId: scopedUserId(grant),
          ...query,
        });
        return reply.send(ok(queue));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/practices/:id/attachments/:attachmentId/validation',
    { config: { permission: 'attachment.validate' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'attachment.validate');
        const { id, attachmentId } = ParamsSchema.parse(req.params);
        const body = ValidationBodySchema.parse(req.body);
        const result = await validateAttachment(deps.prisma, {
          tenantId: grant.principal.tenantId,
          practiceId: id,
          attachmentId,
          ownerUserId: scopedUserId(grant),
          actorUserId: grant.principal.userId,
          data: body,
        });
        return reply.send(ok(result));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  done();
};
