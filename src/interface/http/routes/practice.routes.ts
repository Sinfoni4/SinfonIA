import { z } from 'zod';

import {
  authorize,
  can,
  PermissionDeniedError,
  practiceReach,
  scopedUserId,
} from '../../../core/authz/authorization.service.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../../../core/index.js';
import {
  practiceChecklist,
  rejectAttachment,
  setAttachmentExpectedKey,
} from '../../../core/practice/document-checklist.js';
import {
  cancelDocumentRequest,
  createDocumentRequest,
  fulfilRequestManually,
  listDocumentRequests,
  listOpenDocumentRequests,
} from '../../../core/practice/document-request.js';
import { assignPractice, listAssignees } from '../../../core/practice/practice-assignment.js';
import { listHolderCandidates, setPracticeHolder } from '../../../core/practice/practice-holder.js';
import { moduleOfTenant, setPracticeSubState } from '../../../core/practice/practice-module.js';
import { allowedNextStates } from '../../../core/workflow/state-machine.js';
import { deadlineCategoriesOf } from '../../../modules/registry.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  AttachmentExpectedBodySchema,
  AttachmentRejectionBodySchema,
  DocumentRequestBodySchema,
  DocumentRequestFulfilBodySchema,
  DocumentRequestParamsSchema,
  PracticeAssignBodySchema,
  PracticeAttachmentParamsSchema,
  PracticeAttachmentQuerySchema,
  PracticeCreateBodySchema,
  PracticeExportBodySchema,
  PracticeHolderBodySchema,
  PracticeIdParamsSchema,
  PracticeListQuerySchema,
  PracticeSubStateBodySchema,
  PracticeTransitionBodySchema,
  PracticeTransitionParamsSchema,
} from '../validation/practice.validation.js';

import { attachmentBodyLimit, readAttachmentUpload } from './attachment-upload.js';

import type { PracticeApplicationService } from '../../../core/practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback } from 'fastify';

const AttachmentDownloadParamsSchema = z.object({
  id: z.string().uuid(),
  attachmentId: z.string().uuid(),
});
const AttachmentIdParamsSchema = AttachmentDownloadParamsSchema;

export type PracticeRoutesDeps = {
  practiceService: PracticeApplicationService;
  maxAttachmentBytes?: number;
  /** A4: assignment of practices; without a database the routes are not registered. */
  prisma?: PrismaClient;
};

export const practiceRoutes: FastifyPluginCallback<PracticeRoutesDeps> = (app, deps, done) => {
  const maxAttachmentBytes = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  // POST /practices — Create a new practice
  app.post('/practices', { config: { permission: 'practice.create' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'practice.create').principal;
      const body = PracticeCreateBodySchema.parse(req.body);
      // AGX-03: opening a practice for someone else is for who may assign practices.
      const forOther = body.holderUserId && body.holderUserId !== auth.userId;
      if (forOther) authorize(auth, 'practice.assign');

      const created = await deps.practiceService.createPractice({
        tenantId: auth.tenantId,
        userId: auth.userId,
        name: body.name,
        kind: body.kind,
        fields: body.fields,
        metadata: body.metadata,
        holderUserId: forOther ? body.holderUserId : null,
      });

      return reply.status(201).send(ok(created));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // GET /practices — List practices with pagination, filters, and search
  app.get('/practices', { config: { permission: 'practice.read' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'practice.read');
      const auth = grant.principal;
      const query = PracticeListQuerySchema.parse(req.query);

      // Own-scoped callers see only their practices, `assigned` ones also those they follow;
      // tenant-scoped ones may filter by user.
      const result = await deps.practiceService.listPracticesPaginated({
        tenantId: auth.tenantId,
        ...practiceReach(grant, query.userId),
        assignedTo: query.assignedTo === 'me' ? auth.userId : query.assignedTo,
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

  const prisma = deps.prisma;
  if (prisma) {
    // A02: the module of the caller's organization, so the dashboard shows its kinds and fields.
    app.get('/modules/current', { config: { permission: 'practice.read' } }, async (req, reply) => {
      try {
        const grant = requirePermission(req, 'practice.read');
        const module = await moduleOfTenant(prisma, grant.principal.tenantId);
        return reply.send(
          ok({
            id: module.id,
            label: module.label,
            description: module.description,
            defaultKind: module.defaultKind,
            practiceTypes: module.practiceTypes,
            deadlineCategories: deadlineCategoriesOf(module),
          }),
        );
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    });

    // A05: the sub-state of a practice inside its common state (whoever may move it).
    app.post(
      '/practices/:id/sub-state',
      { config: { permission: 'practice.transition' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.transition');
          const { id } = PracticeIdParamsSchema.parse(req.params);
          const body = PracticeSubStateBodySchema.parse(req.body);
          const result = await setPracticeSubState(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            subState: body.subState,
            actorUserId: grant.principal.userId,
            ownerUserId: scopedUserId(grant),
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // A4: the administrators and operators a practice can be assigned to.
    app.get(
      '/practices/assignees',
      { config: { permission: 'practice.assign' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.assign');
          return reply.send(ok(await listAssignees(prisma, grant.principal.tenantId)));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-06: the document requests of a practice, for whoever reaches it.
    app.get(
      '/practices/:id/document-requests',
      { config: { permission: 'practice.read' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.read');
          const { id } = PracticeIdParamsSchema.parse(req.params);
          await deps.practiceService.getPractice({
            tenantId: grant.principal.tenantId,
            practiceId: id,
            ...practiceReach(grant),
          });
          return reply.send(
            ok(
              await listDocumentRequests(prisma, {
                tenantId: grant.principal.tenantId,
                practiceId: id,
              }),
            ),
          );
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-06: asking for, cancelling and linking documents is for who checks the documents of the
    // whole organization (like a rejection).
    const staffGrant = (req: Parameters<typeof requirePermission>[0]) => {
      const grant = requirePermission(req, 'attachment.validate');
      if (grant.scope !== 'tenant') throw new PermissionDeniedError('attachment.validate');
      return grant;
    };

    app.get(
      '/document-requests',
      { config: { permission: 'attachment.validate' } },
      async (req, reply) => {
        try {
          const grant = staffGrant(req);
          return reply.send(ok(await listOpenDocumentRequests(prisma, grant.principal.tenantId)));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    app.post(
      '/practices/:id/document-requests',
      { config: { permission: 'attachment.validate' } },
      async (req, reply) => {
        try {
          const grant = staffGrant(req);
          const { id } = PracticeIdParamsSchema.parse(req.params);
          const body = DocumentRequestBodySchema.parse(req.body);
          const created = await createDocumentRequest(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            expectedKey: body.expectedKey ?? null,
            message: body.message,
            dueDate: body.dueDate ?? null,
            actorUserId: grant.principal.userId,
            requesterOrgId: grant.principal.tenantId,
            channel: req.headers['x-sinfonia-client'] === 'web' ? 'web' : 'api',
          });
          return reply.status(201).send(ok(created));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    app.post(
      '/practices/:id/document-requests/:requestId/cancel',
      { config: { permission: 'attachment.validate' } },
      async (req, reply) => {
        try {
          const grant = staffGrant(req);
          const { id, requestId } = DocumentRequestParamsSchema.parse(req.params);
          await cancelDocumentRequest(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            requestId,
            actorUserId: grant.principal.userId,
          });
          return reply.send(ok({ cancelled: true }));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    app.post(
      '/practices/:id/document-requests/:requestId/fulfil',
      { config: { permission: 'attachment.validate' } },
      async (req, reply) => {
        try {
          const grant = staffGrant(req);
          const { id, requestId } = DocumentRequestParamsSchema.parse(req.params);
          const body = DocumentRequestFulfilBodySchema.parse(req.body);
          const result = await fulfilRequestManually(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            requestId,
            attachmentId: body.attachmentId,
            actorUserId: grant.principal.userId,
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-05: the document checklist of a practice, for whoever reaches it.
    app.get(
      '/practices/:id/checklist',
      { config: { permission: 'practice.read' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.read');
          const { id } = PracticeIdParamsSchema.parse(req.params);
          await deps.practiceService.getPractice({
            tenantId: grant.principal.tenantId,
            practiceId: id,
            ...practiceReach(grant),
          });
          return reply.send(
            ok(
              await practiceChecklist(prisma, {
                tenantId: grant.principal.tenantId,
                practiceId: id,
              }),
            ),
          );
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-05: which expected document a file is. Like the check of its data: own practices for
    // a member, the organization's for administrators and operators.
    app.post(
      '/practices/:id/attachments/:attachmentId/expected',
      { config: { permission: 'attachment.validate' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'attachment.validate');
          const { id, attachmentId } = AttachmentIdParamsSchema.parse(req.params);
          const body = AttachmentExpectedBodySchema.parse(req.body);
          const result = await setAttachmentExpectedKey(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            attachmentId,
            expectedKey: body.expectedKey,
            actorUserId: grant.principal.userId,
            ownerUserId: scopedUserId(grant),
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-05: rejecting a file is for who checks the documents of the whole organization; a person
    // never rejects their own.
    app.post(
      '/practices/:id/attachments/:attachmentId/rejection',
      { config: { permission: 'attachment.validate' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'attachment.validate');
          if (grant.scope !== 'tenant') throw new PermissionDeniedError('attachment.validate');
          const { id, attachmentId } = AttachmentIdParamsSchema.parse(req.params);
          const body = AttachmentRejectionBodySchema.parse(req.body);
          const result = await rejectAttachment(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            attachmentId,
            reason: body.reason,
            actorUserId: grant.principal.userId,
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-03: the people a practice can be opened for (active members of the organization).
    app.get(
      '/practices/holders',
      { config: { permission: 'practice.assign' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.assign');
          return reply.send(ok(await listHolderCandidates(prisma, grant.principal.tenantId)));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // AGX-03: sets the holder of a practice, or gives it back to its creator (`userId: null`).
    app.post(
      '/practices/:id/holder',
      { config: { permission: 'practice.assign' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.assign');
          const { id } = PracticeIdParamsSchema.parse(req.params);
          const body = PracticeHolderBodySchema.parse(req.body);
          const result = await setPracticeHolder(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            holderUserId: body.userId,
            actorUserId: grant.principal.userId,
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );

    // A4: assigns a practice to an administrator or operator, or to nobody (`userId: null`).
    app.post(
      '/practices/:id/assign',
      { config: { permission: 'practice.assign' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'practice.assign');
          const { id } = PracticeIdParamsSchema.parse(req.params);
          const body = PracticeAssignBodySchema.parse(req.body);
          const result = await assignPractice(prisma, {
            tenantId: grant.principal.tenantId,
            practiceId: id,
            assigneeUserId: body.userId,
            actorUserId: grant.principal.userId,
          });
          return reply.send(ok(result));
        } catch (err: unknown) {
          const mapped = mapErrorToHttp(err);
          return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
        }
      },
    );
  }

  // GET /practices/:id — Get single practice details
  app.get('/practices/:id', { config: { permission: 'practice.read' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'practice.read');
      const auth = grant.principal;
      const params = PracticeIdParamsSchema.parse(req.params);

      const practice = await deps.practiceService.getPractice({
        tenantId: auth.tenantId,
        practiceId: params.id,
        ...practiceReach(grant),
      });

      // The next states the caller may set (B6): the dashboard shows only valid actions, the
      // transition itself is still checked by the backend.
      const allowedTransitions = can(auth.role, 'practice.transition')
        ? allowedNextStates(practice.status)
        : [];
      return reply.status(200).send(ok({ ...practice, allowedTransitions }));
    } catch (err: unknown) {
      const mapped = mapErrorToHttp(err);
      return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
    }
  });

  // POST /practices/export — Export practices as CSV (with time filter)
  app.post(
    '/practices/export',
    { config: { permission: 'practice.export' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'practice.export');
        const auth = grant.principal;
        const body = PracticeExportBodySchema.parse(req.body ?? {});

        const targetUserId = scopedUserId(grant);

        const exported = await deps.practiceService.exportPractices({
          tenantId: auth.tenantId,
          userId: targetUserId,
          filter: body.filter,
          // The dashboard marks its requests (B8): a label for the audit, not a permission.
          audit: {
            actorUserId: auth.userId,
            channel: req.headers['x-sinfonia-client'] === 'web' ? 'web' : 'api',
          },
        });

        return reply.status(200).send(ok(exported));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // POST /practices/:id/transition — Transition practice lifecycle state
  app.post(
    '/practices/:id/transition',
    { config: { permission: 'practice.transition' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'practice.transition').principal;

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
    },
  );

  // POST /practices/:id/attachments — Upload an attachment and process OCR.
  // Accepts multipart/form-data (field "file", optional "hint" sent before the file)
  // or JSON with base64 content.
  app.post(
    '/practices/:id/attachments',
    {
      bodyLimit: attachmentBodyLimit(maxAttachmentBytes),
      config: { permission: 'attachment.create' },
    },
    async (req, reply) => {
      try {
        // Own practices only, whatever the role: the service filters by the uploader.
        const auth = requirePermission(req, 'attachment.create').principal;
        const params = PracticeAttachmentParamsSchema.parse(req.params);
        const { allowDuplicate } = PracticeAttachmentQuerySchema.parse(req.query);
        const upload = await readAttachmentUpload(req);

        const result = await deps.practiceService.addAttachment({
          tenantId: auth.tenantId,
          userId: auth.userId,
          practiceId: params.id,
          ...upload,
          allowDuplicate,
          channel: 'dashboard',
        });

        return reply.status(201).send(ok(result));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // GET /practices/:id/attachments — List attachments for a practice
  app.get(
    '/practices/:id/attachments',
    { config: { permission: 'attachment.read' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'attachment.read');
        const auth = grant.principal;
        const params = PracticeAttachmentParamsSchema.parse(req.params);

        const attachments = await deps.practiceService.listAttachments({
          tenantId: auth.tenantId,
          practiceId: params.id,
          ...practiceReach(grant),
        });

        return reply.status(200).send(ok(attachments));
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  // GET /practices/:id/attachments/:attachmentId/download — the file, after the access check.
  app.get(
    '/practices/:id/attachments/:attachmentId/download',
    { config: { permission: 'attachment.read' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'attachment.read');
        const params = AttachmentDownloadParamsSchema.parse(req.params);
        const file = await deps.practiceService.downloadAttachment({
          tenantId: grant.principal.tenantId,
          practiceId: params.id,
          attachmentId: params.attachmentId,
          ...practiceReach(grant),
        });
        // Never cached, always downloaded (no rendering of uploaded content in the browser).
        return reply
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header(
            'content-disposition',
            `attachment; filename="${file.fileName.replace(/[^\w.-]/g, '_')}"`,
          )
          .type(file.mimeType)
          .send(file.content);
      } catch (err: unknown) {
        const mapped = mapErrorToHttp(err);
        return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
      }
    },
  );

  done();
};
