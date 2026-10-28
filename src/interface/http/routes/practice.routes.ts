import { AttachmentRejectedError, DEFAULT_MAX_ATTACHMENT_BYTES } from '../../../core/index.js';
import { AUTH_ROLES } from '../auth/auth.types.js';
import { requireRole } from '../auth/guards.js';
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

  // POST /practices/:id/attachments — Upload an attachment and process OCR.
  // Accepts multipart/form-data (field "file", optional "hint" sent before the file)
  // or JSON with base64 content.
  app.post(
    '/practices/:id/attachments',
    { bodyLimit: Math.ceil((maxAttachmentBytes * 4) / 3) + BASE64_ENVELOPE_BYTES },
    async (req, reply) => {
      try {
        const auth = requireRole(req, AUTH_ROLES.PRACTICE_CREATE);
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
  app.get('/practices/:id/attachments', async (req, reply) => {
    try {
      const auth = requireRole(req, AUTH_ROLES.PRACTICE_READ);
      const params = PracticeAttachmentParamsSchema.parse(req.params);

      // Members are strictly restricted to their own practices.
      const targetUserId = auth.role === 'MEMBER' ? auth.userId : undefined;

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
  });

  done();
};
