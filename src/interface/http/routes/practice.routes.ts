import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  PracticeTransitionBodySchema,
  PracticeTransitionParamsSchema,
} from '../validation/practice.validation.js';

import type { PracticeWorkflow } from '../../../core/workflow/practice.workflow.js';
import type { FastifyPluginCallback } from 'fastify';

export type PracticeRoutesDeps = {
  practiceWorkflow: PracticeWorkflow;
};

// NOTE: We keep Fastify generics intentionally loose here.
// The interface layer should not couple its route typing to a specific logger type/config.
export const practiceRoutes: FastifyPluginCallback<PracticeRoutesDeps> = (app, deps, done) => {
  // Future-ready: auth/tenant extraction will become middleware.
  // For now we read tenantId from header as a temporary bootstrap mechanism.
  app.post('/practices/:id/transition', async (req, reply) => {
    try {
      const tenantIdHeader = req.headers['x-tenant-id'];
      const tenantId = typeof tenantIdHeader === 'string' ? tenantIdHeader : '';
      if (!tenantId) {
        return reply.status(400).send(fail('MISSING_TENANT', 'Missing x-tenant-id header'));
      }

      const userIdHeader = req.headers['x-user-id'];
      const userId = typeof userIdHeader === 'string' && userIdHeader ? userIdHeader : null;

      const params = PracticeTransitionParamsSchema.parse(req.params);
      const body = PracticeTransitionBodySchema.parse(req.body);

      const updated = await deps.practiceWorkflow.transitionPractice({
        tenantId,
        practiceId: params.id,
        nextState: body.nextState,
        userId,
      });

      return reply.status(200).send(ok(updated));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });
  done();
};
