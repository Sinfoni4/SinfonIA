import { AUTH_ROLES } from '../auth/auth.types.js';
import { requireRole } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  ComplianceDeadlineCreateBodySchema,
  ComplianceDeadlineListQuerySchema,
  ComplianceDeadlineParamsSchema,
} from '../validation/compliance.validation.js';

import type { ComplianceService } from '../../../core/compliance/compliance.service.js';
import type { FastifyPluginCallback } from 'fastify';

export type ComplianceRoutesDeps = {
  complianceService: ComplianceService;
};

export const complianceRoutes: FastifyPluginCallback<ComplianceRoutesDeps> = (app, deps, done) => {
  // POST /compliance/deadlines — Create a deadline (reminders at 30/15/7/1 days and on the day)
  app.post('/compliance/deadlines', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.COMPLIANCE_MANAGE);
      const body = ComplianceDeadlineCreateBodySchema.parse(req.body);

      const created = await deps.complianceService.createDeadline({
        tenantId: auth.tenantId,
        createdBy: auth.userId,
        userId: body.userId ?? null,
        category: body.category,
        title: body.title,
        dueDate: body.dueDate,
        notes: body.notes ?? null,
      });

      return reply.status(201).send(ok(created));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // GET /compliance/deadlines — List deadlines, soonest first
  app.get('/compliance/deadlines', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.COMPLIANCE_READ);
      const query = ComplianceDeadlineListQuerySchema.parse(req.query);

      // Members only see the deadlines that refer to them.
      const userId = auth.role === 'MEMBER' ? auth.userId : query.userId;

      const deadlines = await deps.complianceService.listDeadlines({
        tenantId: auth.tenantId,
        status: query.status,
        category: query.category,
        userId,
        withinDays: query.withinDays,
        limit: query.limit,
      });

      return reply.send(ok(deadlines));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // POST /compliance/deadlines/:id/close — Close a deadline (renewed or handled): no more reminders
  app.post('/compliance/deadlines/:id/close', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.COMPLIANCE_MANAGE);
      const params = ComplianceDeadlineParamsSchema.parse(req.params);

      const closed = await deps.complianceService.closeDeadline({
        tenantId: auth.tenantId,
        idOrPrefix: params.id,
        closedBy: auth.userId,
      });

      return reply.send(ok(closed));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  done();
};
