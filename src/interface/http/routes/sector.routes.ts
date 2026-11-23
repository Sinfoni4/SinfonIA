import { z } from 'zod';

import { SectorRecordService } from '../../../core/sector/sector-records.service.js';
import { requirePrincipal } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import { attachmentBodyLimit, readAttachmentUpload } from './attachment-upload.js';

import type { ComplianceService } from '../../../core/compliance/compliance.service.js';
import type { StorageService } from '../../../data/storage/storage.service.js';
import type { SectorChannel } from '../../../modules/registry.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type SectorRoutesDeps = {
  prisma: PrismaClient;
  complianceService?: ComplianceService;
  /** The files of the entries; without it, entries take no files. */
  storage?: StorageService;
  maxAttachmentBytes?: number;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const FeatureParams = z.object({ feature: z.string().regex(/^[a-z_]{2,40}$/) });
const RecordParams = FeatureParams.extend({ id: z.string().uuid() });
const FileParams = RecordParams.extend({ attachmentId: z.string().uuid() });
const ExportQuery = z
  .object({
    format: z.enum(['csv', 'xlsx', 'pdf']),
    kind: z.string().max(40).optional(),
    search: z.string().max(200).optional(),
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
    expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  })
  .strict();
const ListQuery = z
  .object({
    kind: z.string().max(40).optional(),
    search: z.string().max(200).optional(),
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
    expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const CreateBody = z
  .object({ kind: z.string().min(1).max(40), data: z.record(z.string(), z.unknown()) })
  .strict();
const UpdateBody = z.object({ data: z.record(z.string(), z.unknown()) }).strict();

/** The dashboard and the Mini App reach the registers on paths of their own (G: channels). */
const PREFIXES: Record<SectorChannel, string> = {
  dashboard: '/sector',
  miniapp: '/miniapp/sector',
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) {
    return reply.status(400).send(fail('VALIDATION_ERROR', 'Richiesta non valida'));
  }
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * The registers of the functions of a sector. Every route declares only «authenticated»: the
 * service checks the function (sector, channel, built) and its own permission at every call.
 */
export const sectorRoutes: FastifyPluginCallback<SectorRoutesDeps> = (app, deps, done) => {
  const service = new SectorRecordService(deps.prisma, {
    ...(deps.complianceService
      ? {
          remindNow: (input: { tenantId: string; deadlineId: string }) =>
            deps.complianceService!.sendDueReminders(input),
        }
      : {}),
    ...(deps.storage ? { storage: deps.storage } : {}),
    maxAttachmentBytes: deps.maxAttachmentBytes ?? DEFAULT_MAX_BYTES,
  });
  const config = { permission: 'authenticated' as const };
  // Never cached, always downloaded: no rendering of uploaded or generated content in the browser.
  const sendFile = (
    reply: FastifyReply,
    file: { fileName: string; mimeType: string; content: Buffer },
  ) =>
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `attachment; filename="${file.fileName.replace(/[^\w.-]/g, '_')}"`,
      )
      .type(file.mimeType)
      .send(file.content);

  for (const channel of Object.keys(PREFIXES) as SectorChannel[]) {
    const base = `${PREFIXES[channel]}/:feature/records`;

    app.get(base, { config }, async (req, reply) => {
      try {
        const { feature } = FeatureParams.parse(req.params);
        const query = ListQuery.parse(req.query);
        return reply.send(
          ok(await service.list(requirePrincipal(req), { feature, channel, ...query })),
        );
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    app.get(`${base}/:id`, { config }, async (req, reply) => {
      try {
        const { feature, id } = RecordParams.parse(req.params);
        return reply.send(ok(await service.get(requirePrincipal(req), { feature, channel, id })));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    app.post(base, { config }, async (req, reply) => {
      try {
        const { feature } = FeatureParams.parse(req.params);
        const body = CreateBody.parse(req.body);
        const created = await service.create(requirePrincipal(req), {
          feature,
          channel,
          kind: body.kind,
          data: body.data,
        });
        return reply.status(201).send(ok(created));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    app.patch(`${base}/:id`, { config }, async (req, reply) => {
      try {
        const { feature, id } = RecordParams.parse(req.params);
        const body = UpdateBody.parse(req.body);
        return reply.send(
          ok(
            await service.update(requirePrincipal(req), { feature, channel, id, data: body.data }),
          ),
        );
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    app.delete(`${base}/:id`, { config }, async (req, reply) => {
      try {
        const { feature, id } = RecordParams.parse(req.params);
        await service.remove(requirePrincipal(req), { feature, channel, id });
        return reply.send(ok({ deleted: true }));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    // The register as a file (CSV, Excel, PDF), with the filters of the page.
    app.get(`${base}/export`, { config }, async (req, reply) => {
      try {
        const { feature } = FeatureParams.parse(req.params);
        const query = ExportQuery.parse(req.query);
        const file = await service.export(requirePrincipal(req), { feature, channel, ...query });
        return sendFile(reply, file);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    // Files of an entry: multipart/form-data (field «file») or JSON with the content in base64.
    app.post(
      `${base}/:id/attachments`,
      { config, bodyLimit: attachmentBodyLimit(deps.maxAttachmentBytes ?? DEFAULT_MAX_BYTES) },
      async (req, reply) => {
        try {
          const { feature, id } = RecordParams.parse(req.params);
          const upload = await readAttachmentUpload(req);
          const record = await service.addAttachment(requirePrincipal(req), {
            feature,
            channel,
            id,
            fileName: upload.fileName,
            content: upload.content,
          });
          return reply.status(201).send(ok(record));
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      },
    );

    app.get(`${base}/:id/attachments/:attachmentId/download`, { config }, async (req, reply) => {
      try {
        const { feature, id, attachmentId } = FileParams.parse(req.params);
        const file = await service.downloadAttachment(requirePrincipal(req), {
          feature,
          channel,
          id,
          attachmentId,
        });
        return sendFile(reply, file);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });

    app.delete(`${base}/:id/attachments/:attachmentId`, { config }, async (req, reply) => {
      try {
        const { feature, id, attachmentId } = FileParams.parse(req.params);
        return reply.send(
          ok(
            await service.removeAttachment(requirePrincipal(req), {
              feature,
              channel,
              id,
              attachmentId,
            }),
          ),
        );
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });
  }

  done();
};
