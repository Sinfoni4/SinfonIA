import { z } from 'zod';

import {
  auditDelegatedUse,
  resolveDelegatedAccess,
} from '../../../core/delegation/delegation.service.js';
import {
  SectorRecordError,
  SectorRecordService,
} from '../../../core/sector/sector-records.service.js';
import { requirePermission, requirePrincipal } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import { attachmentBodyLimit, readAttachmentUpload } from './attachment-upload.js';

import type { Principal } from '../../../core/authz/authorization.service.js';
import type { ComplianceService } from '../../../core/compliance/compliance.service.js';
import type { StorageService } from '../../../data/storage/storage.service.js';
import type { SectorChannel } from '../../../modules/registry.js';
import type { GrantOperation, PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

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
const GrantFeatureParams = FeatureParams.extend({ grantId: z.string().uuid() });
const GrantRecordParams = GrantFeatureParams.extend({ id: z.string().uuid() });
const GrantFileParams = GrantRecordParams.extend({ attachmentId: z.string().uuid() });
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

  // --- through a delegation (MF8) -------------------------------------------------------------
  // The registers a delegation covers, of the grantor, on the dashboard: every request checks the
  // delegation, its operation and the register, then works as the grantor's staff would, without
  // ever showing its people; every use goes in the grantor's log.
  const delegated = async (
    req: FastifyRequest,
    grantId: string,
    feature: string,
    operation: Extract<GrantOperation, 'READ' | 'CREATE' | 'UPDATE' | 'EXPORT'>,
  ) => {
    const own = requirePermission(req, 'grant.use').principal;
    const access = await resolveDelegatedAccess(deps.prisma, {
      grantId,
      userId: own.userId,
      currentOrgId: own.tenantId,
      operation,
    });
    if (!access.registers.includes(feature)) {
      throw new SectorRecordError(
        'Questo registro non è compreso nella delega',
        403,
        'REGISTER_NOT_DELEGATED',
      );
    }
    const grantor = await deps.prisma.tenant.findUniqueOrThrow({
      where: { id: access.grantorOrgId },
      select: { disabledFeatures: true },
    });
    const principal: Principal = {
      tenantId: access.grantorOrgId,
      userId: own.userId,
      role: 'OPERATOR',
      customPermissions: null,
      disabledFeatures: grantor.disabledFeatures,
      delegation: { grantId: access.grantId, operations: access.operations },
    };
    const audit = (action: string, extra: Record<string, string> = {}) =>
      auditDelegatedUse(deps.prisma, access, own.userId, action, { register: feature, ...extra });
    return {
      principal,
      audit,
      delegation: {
        grantorName: access.grantorName,
        operations: access.operations,
        validUntil: access.validUntil,
      },
    };
  };
  const grantConfig = { permission: 'grant.use' as const };
  const grantBase = '/grants/:grantId/sector/:feature/records';
  const channel: SectorChannel = 'dashboard';

  app.get(grantBase, { config: grantConfig }, async (req, reply) => {
    try {
      const { grantId, feature } = GrantFeatureParams.parse(req.params);
      const query = ListQuery.parse(req.query);
      const d = await delegated(req, grantId, feature, 'READ');
      const page = await service.list(d.principal, { feature, channel, ...query });
      await d.audit('list');
      return reply.send(ok({ ...page, delegation: d.delegation }));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get(`${grantBase}/export`, { config: grantConfig }, async (req, reply) => {
    try {
      const { grantId, feature } = GrantFeatureParams.parse(req.params);
      const query = ExportQuery.parse(req.query);
      const d = await delegated(req, grantId, feature, 'EXPORT');
      const file = await service.export(d.principal, { feature, channel, ...query });
      await d.audit('export');
      return sendFile(reply, file);
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post(grantBase, { config: grantConfig }, async (req, reply) => {
    try {
      const { grantId, feature } = GrantFeatureParams.parse(req.params);
      const d = await delegated(req, grantId, feature, 'CREATE');
      const body = CreateBody.parse(req.body);
      const created = await service.create(d.principal, {
        feature,
        channel,
        kind: body.kind,
        data: body.data,
      });
      await d.audit('create', { recordId: created.id });
      return reply.status(201).send(ok(created));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.patch(`${grantBase}/:id`, { config: grantConfig }, async (req, reply) => {
    try {
      const { grantId, feature, id } = GrantRecordParams.parse(req.params);
      const d = await delegated(req, grantId, feature, 'UPDATE');
      const body = UpdateBody.parse(req.body);
      const updated = await service.update(d.principal, { feature, channel, id, data: body.data });
      await d.audit('update', { recordId: id });
      return reply.send(ok(updated));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post(
    `${grantBase}/:id/attachments`,
    {
      config: grantConfig,
      bodyLimit: attachmentBodyLimit(deps.maxAttachmentBytes ?? DEFAULT_MAX_BYTES),
    },
    async (req, reply) => {
      try {
        const { grantId, feature, id } = GrantRecordParams.parse(req.params);
        const d = await delegated(req, grantId, feature, 'UPDATE');
        const upload = await readAttachmentUpload(req);
        const record = await service.addAttachment(d.principal, {
          feature,
          channel,
          id,
          fileName: upload.fileName,
          content: upload.content,
        });
        await d.audit('upload', { recordId: id });
        return reply.status(201).send(ok(record));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    `${grantBase}/:id/attachments/:attachmentId/download`,
    { config: grantConfig },
    async (req, reply) => {
      try {
        const { grantId, feature, id, attachmentId } = GrantFileParams.parse(req.params);
        const d = await delegated(req, grantId, feature, 'READ');
        const file = await service.downloadAttachment(d.principal, {
          feature,
          channel,
          id,
          attachmentId,
        });
        await d.audit('download', { recordId: id });
        return sendFile(reply, file);
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  done();
};
