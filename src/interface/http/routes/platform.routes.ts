import { z } from 'zod';

import {
  createOrganization,
  getOrganization,
  listOrganizations,
  listPlatformAudit,
  setOrganizationSuspended,
} from '../../../core/platform/platform.service.js';
import { requirePlatform } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { LoginService } from '../../../core/identity/login.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type PlatformRoutesDeps = { prisma: PrismaClient; login: LoginService };

const TYPES = [
  'COMPANY',
  'COOPERATIVE',
  'NETWORK',
  'CONSORTIUM',
  'TRADE_ASSOCIATION',
  'ASSOCIATION',
  'PROFESSIONAL_FIRM',
  'OTHER',
] as const;
const STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'PENDING_DELETION'] as const;

/** G2: the fresh code that confirms a critical action, sent with the action itself. */
const VerificationSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  type: z.enum(TYPES).optional(),
  status: z.enum(STATUSES).optional(),
});

const CreateBodySchema = z
  .object({
    name: z.string().max(200),
    type: z.enum(TYPES),
    firstAdminEmail: z.string().trim().email().max(254),
    verification: VerificationSchema,
  })
  .strict();

const IdParamsSchema = z.object({ id: z.string().uuid() });

const SuspendBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    verification: VerificationSchema,
  })
  .strict();

const ReactivateBodySchema = z.object({ verification: VerificationSchema }).strict();

const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  orgId: z.string().uuid().optional(),
});

function sendError(reply: FastifyReply, err: unknown) {
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * The platform console (docs/PROGETTO_FRONTEND_V2.md §5-§6, FE7: A1-A3, A6; B13-B15, B18).
 * Reached only with a platform token (see the auth hook); creating and suspending need a fresh
 * confirmation code (G2).
 */
export const platformRoutes: FastifyPluginCallback<PlatformRoutesDeps> = (app, deps, done) => {
  const config = { permission: 'platform' as const };

  // The administrator and their own organizations, to go back to them from the console.
  app.get('/platform/me', { config }, async (req, reply) => {
    try {
      const { userId, email } = requirePlatform(req);
      const { organizations } = await deps.login.profile(userId);
      return reply.send(ok({ userId, email, organizations }));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // A code to the administrator's own email, to confirm the next critical action.
  app.post('/platform/verification', { config }, async (req, reply) => {
    try {
      const { userId } = requirePlatform(req);
      return reply.status(201).send(ok(await deps.login.startStepUp(userId)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get('/platform/organizations', { config }, async (req, reply) => {
    try {
      requirePlatform(req);
      const query = ListQuerySchema.parse(req.query);
      return reply.send(ok(await listOrganizations(deps.prisma, query)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/platform/organizations', { config }, async (req, reply) => {
    try {
      const { userId } = requirePlatform(req);
      const body = CreateBodySchema.parse(req.body);
      await deps.login.confirmStepUp(userId, body.verification.challengeId, body.verification.code);
      const created = await createOrganization(
        deps.prisma,
        deps.login,
        { name: body.name, type: body.type, firstAdminEmail: body.firstAdminEmail },
        { userId },
      );
      return reply.status(201).send(ok(created));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get('/platform/organizations/:id', { config }, async (req, reply) => {
    try {
      requirePlatform(req);
      const { id } = IdParamsSchema.parse(req.params);
      return reply.send(ok(await getOrganization(deps.prisma, id)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/platform/organizations/:id/suspend', { config }, async (req, reply) => {
    try {
      const { userId } = requirePlatform(req);
      const { id } = IdParamsSchema.parse(req.params);
      const body = SuspendBodySchema.parse(req.body);
      await deps.login.confirmStepUp(userId, body.verification.challengeId, body.verification.code);
      return reply.send(
        ok(await setOrganizationSuspended(deps.prisma, id, true, { userId }, body.reason)),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/platform/organizations/:id/reactivate', { config }, async (req, reply) => {
    try {
      const { userId } = requirePlatform(req);
      const { id } = IdParamsSchema.parse(req.params);
      const body = ReactivateBodySchema.parse(req.body);
      await deps.login.confirmStepUp(userId, body.verification.challengeId, body.verification.code);
      return reply.send(ok(await setOrganizationSuspended(deps.prisma, id, false, { userId })));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get('/platform/audit', { config }, async (req, reply) => {
    try {
      requirePlatform(req);
      const query = AuditQuerySchema.parse(req.query);
      return reply.send(ok(await listPlatformAudit(deps.prisma, query)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  done();
};
