import { AUTH_ROLES } from '../auth/auth.types.js';
import { requireRole } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  PracticeCreateBodySchema,
  PracticeExportBodySchema,
  PracticeIdParamsSchema,
  PracticeListQuerySchema,
  PracticeTransitionBodySchema,
  PracticeTransitionParamsSchema,
} from '../validation/practice.validation.js';

import type { PracticeApplicationService } from '../../../core/practice/practice.application.service.js';
import type { FastifyPluginCallback } from 'fastify';

export type PracticeRoutesDeps = {
  practiceService: PracticeApplicationService;
};

export const practiceRoutes: FastifyPluginCallback<PracticeRoutesDeps> = (app, deps, done) => {
  // POST /practices — Create a new practice
  app.post('/practices', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.PRACTICE_CREATE);
      const body = PracticeCreateBodySchema.parse(req.body);

      const created = await deps.practiceService.createPractice({
        tenantId: auth.tenantId,
        userId: auth.userId,
        name: body.name,
        kind: body.kind,
        metadata: body.metadata,
      });

      return reply.status(201).send(ok(created));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // GET /practices — List practices with pagination, filters, and search
  app.get('/practices', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.PRACTICE_READ);
      const query = PracticeListQuerySchema.parse(req.query);

      // Members are strictly scoped to their own practices.
      // Operators and Admins can query tenant-wide or filter by specific userId.
      const targetUserId = auth.role === 'MEMBER' ? auth.userId : query.userId;

      const result = await deps.practiceService.listPracticesPaginated({
        tenantId: auth.tenantId,
        userId: targetUserId,
        status: query.status,
        search: query.search,
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });

      return reply.status(200).send(ok(result));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // GET /practices/:id — Get single practice details
  app.get('/practices/:id', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.PRACTICE_READ);
      const params = PracticeIdParamsSchema.parse(req.params);

      // Members are strictly restricted to their own practices.
      const targetUserId = auth.role === 'MEMBER' ? auth.userId : undefined;

      const practice = await deps.practiceService.getPractice({
        tenantId: auth.tenantId,
        practiceId: params.id,
        userId: targetUserId,
      });

      return reply.status(200).send(ok(practice));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // POST /practices/export — Export practices as CSV (with time filter)
  app.post('/practices/export', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.PRACTICE_EXPORT);
      const body = PracticeExportBodySchema.parse(req.body ?? {});

      const targetUserId = auth.role === 'MEMBER' ? auth.userId : undefined;

      const exported = await deps.practiceService.exportPractices({
        tenantId: auth.tenantId,
        userId: targetUserId,
        filter: body.filter,
      });

      return reply.status(200).send(ok(exported));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // POST /practices/:id/transition — Transition practice lifecycle state
  app.post('/practices/:id/transition', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.PRACTICE_TRANSITION);

      const params = PracticeTransitionParamsSchema.parse(req.params);
      const body = PracticeTransitionBodySchema.parse(req.body);

      const updated = await deps.practiceService.transitionPractice({
        tenantId: auth.tenantId,
        practiceId: params.id,
        nextState: body.nextState,
        userId: auth.userId,
      });

      return reply.status(200).send(ok(updated));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  done();
};
