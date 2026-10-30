import { z } from 'zod';

import { can, scopedUserId } from '../../../core/authz/authorization.service.js';
import { AttachmentRejectedError, DEFAULT_MAX_ATTACHMENT_BYTES } from '../../../core/index.js';
import { allowedNextStates } from '../../../core/workflow/state-machine.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  PracticeAttachmentBodySchema,
  PracticeAttachmentParamsSchema,
  PracticeCreateBodySchema,
  PracticeExportBodySchema,
  PracticeIdParamsSchema,
  PracticeListQuerySchema,
  PracticeTransitionBodySchema,
  PracticeTransitionParamsSchema,
} from '../validation/practice.validation.js';

import type { PracticeApplicationService } from '../../../core/practice/practice.application.service.js';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';

const AttachmentDownloadParamsSchema = z.object({
  id: z.string().uuid(),
  attachmentId: z.string().uuid(),
});

export type PracticeRoutesDeps = {
  practiceService: PracticeApplicationService;
  maxAttachmentBytes?: number;
};

type AttachmentUpload = { fileName: string; mimeType: string; content: Buffer; hint?: string };

// Room for the JSON envelope around the base64 content (file name, MIME type, hint).
const BASE64_ENVELOPE_BYTES = 64 * 1024;

function readBase64Upload(body: unknown): AttachmentUpload {
  const parsed = PracticeAttachmentBodySchema.parse(body);
  return {
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    content: Buffer.from(parsed.contentBase64, 'base64'),
    hint: parsed.hint,
  };
}

// Reads every part, so the optional "hint" field is accepted before or after the file.
async function readMultipartUpload(req: FastifyRequest): Promise<AttachmentUpload> {
  let file: Omit<AttachmentUpload, 'hint'> | undefined;
  let hint: string | undefined;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const content = await part.toBuffer();
        if (part.fieldname === 'file') {
          file = { fileName: part.filename, mimeType: part.mimetype, content };
        }
      } else if (part.fieldname === 'hint') {
        hint = String(part.value);
      }
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AttachmentRejectedError('ATTACHMENT_TOO_LARGE', 'The attached file is too large');
    }
    throw err;
  }
  if (!file) {
    throw new AttachmentRejectedError('EMPTY_ATTACHMENT', 'Multipart field "file" is required');
  }
  return { ...file, hint };
}

export const practiceRoutes: FastifyPluginCallback<PracticeRoutesDeps> = (app, deps, done) => {
  const maxAttachmentBytes = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  // POST /practices — Create a new practice
  app.post('/practices', { config: { permission: 'practice.create' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'practice.create').principal;
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
  app.get('/practices', { config: { permission: 'practice.read' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'practice.read');
      const auth = grant.principal;
      const query = PracticeListQuerySchema.parse(req.query);

      // Own-scoped callers see only their practices; tenant-scoped ones may filter by user.
      const targetUserId = scopedUserId(grant, query.userId);

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
  app.get('/practices/:id', { config: { permission: 'practice.read' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'practice.read');
      const auth = grant.principal;
      const params = PracticeIdParamsSchema.parse(req.params);

      const targetUserId = scopedUserId(grant);

      const practice = await deps.practiceService.getPractice({
        tenantId: auth.tenantId,
        practiceId: params.id,
        userId: targetUserId,
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
      bodyLimit: Math.ceil((maxAttachmentBytes * 4) / 3) + BASE64_ENVELOPE_BYTES,
      config: { permission: 'attachment.create' },
    },
    async (req, reply) => {
      try {
        // Own practices only, whatever the role: the service filters by the uploader.
        const auth = requirePermission(req, 'attachment.create').principal;
        const params = PracticeAttachmentParamsSchema.parse(req.params);
        const upload = req.isMultipart()
          ? await readMultipartUpload(req)
          : readBase64Upload(req.body);

        const result = await deps.practiceService.addAttachment({
          tenantId: auth.tenantId,
          userId: auth.userId,
          practiceId: params.id,
          ...upload,
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

        const targetUserId = scopedUserId(grant);

        const attachments = await deps.practiceService.listAttachments({
          tenantId: auth.tenantId,
          practiceId: params.id,
          userId: targetUserId,
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
          userId: scopedUserId(grant),
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
