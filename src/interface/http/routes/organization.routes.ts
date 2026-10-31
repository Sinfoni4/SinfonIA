import { z } from 'zod';

import { listAuditEvents } from '../../../core/audit/audit-view.service.js';
import { authorize, scopedUserId } from '../../../core/authz/authorization.service.js';
import { dashboardSummary } from '../../../core/dashboard/dashboard.service.js';
import {
  getOrganizationSettings,
  updateOrganizationSettings,
} from '../../../core/organization/organization-settings.service.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import type { ComplianceService } from '../../../core/compliance/compliance.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type OrganizationRoutesDeps = {
  prisma: PrismaClient;
  complianceService?: Pick<ComplianceService, 'listDeadlines'>;
};

const AuditQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    // Comma-separated event types, e.g. MEMBER_ROLE_CHANGED,MEMBERSHIP_REVOKED.
    types: z
      .string()
      .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
      .max(500)
      .optional(),
    userId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" must not be after "to"',
  });

const SettingsBodySchema = z
  .object({
    name: z.string().max(200).optional(),
    scheduledExport: z
      .object({
        enabled: z.boolean(),
        frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
      })
      .optional(),
  })
  .strict();

function sendError(reply: FastifyReply, err: unknown) {
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * The organization in the dashboard (FE6, docs/PROGETTO_FRONTEND_V2.md §3 and §6, B10-B12):
 * the numbers of the home within the caller's scope, the activity log for administrators, and
 * the settings an administrator manages.
 */
export const organizationRoutes: FastifyPluginCallback<OrganizationRoutesDeps> = (
  app,
  deps,
  done,
) => {
  // Everyone sees the home: each number is limited by the caller's own grants.
  app.get('/dashboard/summary', { config: { permission: 'practice.read' } }, async (req, reply) => {
    try {
      const practices = requirePermission(req, 'practice.read');
      const deadlines = authorize(practices.principal, 'compliance.read');
      const summary = await dashboardSummary(deps.prisma, deps.complianceService, {
        tenantId: practices.principal.tenantId,
        practiceUserId: scopedUserId(practices),
        deadlineUserId: scopedUserId(deadlines),
      });
      return reply.send(ok(summary));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get('/audit', { config: { permission: 'audit.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'audit.read').principal;
      const query = AuditQuerySchema.parse(req.query);
      const page = await listAuditEvents(deps.prisma, {
        tenantId: auth.tenantId,
        page: query.page,
        limit: query.limit,
        types: query.types?.split(','),
        userId: query.userId,
        from: query.from,
        to: query.to,
      });
      return reply.send(ok(page));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get(
    '/organization',
    { config: { permission: 'organization.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'organization.manage').principal;
        return reply.send(ok(await getOrganizationSettings(deps.prisma, auth.tenantId)));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.patch(
    '/organization',
    { config: { permission: 'organization.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'organization.manage').principal;
        const body = SettingsBodySchema.parse(req.body ?? {});
        const settings = await updateOrganizationSettings(deps.prisma, auth.tenantId, body, {
          userId: auth.userId,
        });
        return reply.send(ok(settings));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  done();
};
