import { z } from 'zod';

import { FEATURES } from '../../../core/features/features.js';
import { MODULE_IDS } from '../../../core/modules/module.contract.js';
import { aiUsage, systemHealth } from '../../../core/platform/platform-health.service.js';
import {
  createOrganization,
  getOrganization,
  inviteToNetwork,
  listOrganizationLinks,
  listOrganizations,
  listPlatformAudit,
  setOrganizationModules,
  setOrganizationSuspended,
} from '../../../core/platform/platform.service.js';
import { requirePlatform } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { LoginService } from '../../../core/identity/login.service.js';
import type { ConfiguredServices } from '../../../core/platform/platform-health.service.js';
import type { HealthLocations } from '../../../core/platform/platform-storage.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type PlatformRoutesDeps = {
  prisma: PrismaClient;
  login: LoginService;
  /** A5: which external services this process is configured for. */
  services?: ConfiguredServices;
  /** Attachment folder and backup folder, for the system health (never shown). */
  locations?: HealthLocations;
};

const NO_SERVICES: ConfiguredServices = {
  telegram: false,
  whatsapp: false,
  webhook: false,
  ai: null,
};

const UsageQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .pipe(z.union([z.literal(1), z.literal(7), z.literal(30)]))
    .default(7),
});

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
    /** A02: the sector module; omitted, the organization gets the default one. */
    module: z.enum(MODULE_IDS).optional(),
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

/** A03: the module and the functions turned off (the full list: what is not in it is on). */
const ModulesBodySchema = z
  .object({
    module: z.enum(MODULE_IDS),
    disabledFeatures: z.array(z.enum(FEATURES)).max(FEATURES.length),
  })
  .strict();

/** Voce 17: the company to invite, by its id (the console picks it from the list). */
const InviteBodySchema = z.object({ orgId: z.string().uuid() }).strict();

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
        {
          name: body.name,
          type: body.type,
          firstAdminEmail: body.firstAdminEmail,
          ...(body.module ? { module: body.module } : {}),
        },
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

  // A03 (voce 16): module and functions of an organization.
  app.patch('/platform/organizations/:id/modules', { config }, async (req, reply) => {
    try {
      const { userId } = requirePlatform(req);
      const { id } = IdParamsSchema.parse(req.params);
      const body = ModulesBodySchema.parse(req.body);
      return reply.send(ok(await setOrganizationModules(deps.prisma, id, body, { userId })));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // Voce 17: memberships of an organization, and invitations of companies into a network.
  app.get('/platform/organizations/:id/links', { config }, async (req, reply) => {
    try {
      requirePlatform(req);
      const { id } = IdParamsSchema.parse(req.params);
      return reply.send(ok(await listOrganizationLinks(deps.prisma, id)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/platform/organizations/:id/network-members', { config }, async (req, reply) => {
    try {
      const { userId } = requirePlatform(req);
      const { id } = IdParamsSchema.parse(req.params);
      const body = InviteBodySchema.parse(req.body);
      return reply
        .status(201)
        .send(ok(await inviteToNetwork(deps.prisma, id, body.orgId, { userId })));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // A5 / FE8: the state of the system (database, deliveries, scheduler, configured services).
  app.get('/platform/health', { config }, async (req, reply) => {
    try {
      requirePlatform(req);
      return reply.send(
        ok(await systemHealth(deps.prisma, deps.services ?? NO_SERVICES, deps.locations)),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // A5 / FE8: use of the AI in the last 1, 7 or 30 days, by day, model and organization.
  app.get('/platform/ai-usage', { config }, async (req, reply) => {
    try {
      requirePlatform(req);
      const { days } = UsageQuerySchema.parse(req.query);
      return reply.send(ok(await aiUsage(deps.prisma, days)));
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
