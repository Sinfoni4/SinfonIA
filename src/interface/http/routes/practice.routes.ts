import { AUTH_ROLES } from '../auth/auth.types.js';
import { requireRole } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  PracticeTransitionBodySchema,
  PracticeTransitionParamsSchema,
} from '../validation/practice.validation.js';

import type { PracticeApplicationService } from '../../../core/practice/practice.application.service.js';
import type { FastifyPluginCallback } from 'fastify';

export type PracticeRoutesDeps = {
  practiceService: PracticeApplicationService;
};

export const practiceRoutes: FastifyPluginCallback<PracticeRoutesDeps> = (app, deps, done) => {
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
