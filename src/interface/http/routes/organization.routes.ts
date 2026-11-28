import { z } from 'zod';

import { listAuditEvents } from '../../../core/audit/audit-view.service.js';
import { authorize, scopedUserId } from '../../../core/authz/authorization.service.js';
import { dashboardSummary } from '../../../core/dashboard/dashboard.service.js';
import { miniAppSummary } from '../../../core/miniapp/miniapp.service.js';
import {
  getCompanyProfile,
  listProfileVersions,
  saveCompanyProfile,
} from '../../../core/organization/company-profile.service.js';
import { readOrganizationAppearance } from '../../../core/organization/organization-appearance.js';
import {
  LOGO_MAX_BYTES,
  readOrganizationLogo,
  setOwnOrganizationLogo,
} from '../../../core/organization/organization-logo.js';
import {
  getOrganizationSettings,
  updateOrganizationSettings,
} from '../../../core/organization/organization-settings.service.js';
import { organizationUsage, usageExport } from '../../../core/usage/usage.service.js';
import { TABLE_FILE_MAX_CSV, tableFile } from '../../../shared/table-file.js';
import { requirePermission, requirePrincipal } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';

import { StatsQuerySchema } from './network.routes.js';
import { LogoBodySchema } from './platform.routes.js';

import type { ComplianceService } from '../../../core/compliance/compliance.service.js';
import type { StorageService } from '../../../data/storage/storage.service.js';
import type { AppChat } from '../../conversation/app-chat.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type OrganizationRoutesDeps = {
  prisma: PrismaClient;
  complianceService?: Pick<ComplianceService, 'listDeadlines'>;
  /** The assistant of the Telegram Mini App (the same conversation as the bot). */
  appChat?: AppChat;
  /** Where the logo of the organization is kept (the attachment storage). */
  storage?: StorageService;
};

const AppChatBodySchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
/** Fase 1C: a new version of the company profile (activities and answers, checked by the service). */
export const ProfileBodySchema = z
  .object({
    activities: z.array(z.string().max(40)).max(30),
    data: z.record(z.string(), z.unknown()),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

/** An export the person already received, to have it as Excel or PDF (no data is read here). */
export const TableFileBodySchema = z
  .object({
    title: z.string().trim().max(200),
    csv: z.string().max(TABLE_FILE_MAX_CSV),
    format: z.enum(['xlsx', 'pdf']),
  })
  .strict();

/** The file in JSON: name, type and content in base64, for the dashboard to save. */
export async function sendTableFile(body: unknown) {
  const input = TableFileBodySchema.parse(body);
  const file = await tableFile(input);
  return {
    fileName: file.fileName,
    mimeType: file.mimeType,
    contentBase64: file.content.toString('base64'),
  };
}

/** Room for a 5 MB CSV in JSON, with its escapes. */
export const TABLE_FILE_BODY_LIMIT = 12 * 1024 * 1024;

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
    municipality: z.string().max(200).nullable().optional(),
    sector: z.string().max(200).nullable().optional(),
    taxCode: z.string().max(40).nullable().optional(),
    vatNumber: z.string().max(40).nullable().optional(),
    scheduledExport: z
      .object({
        enabled: z.boolean(),
        frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
      })
      .optional(),
    miniAppBackground: z.string().max(20).nullable().optional(),
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

  // The exports of the dashboard as Excel or PDF: the CSV the person already has, converted.
  app.post(
    '/exports/file',
    { config: { permission: 'authenticated' }, bodyLimit: TABLE_FILE_BODY_LIMIT },
    async (req, reply) => {
      try {
        requirePrincipal(req);
        return reply.send(ok(await sendTableFile(req.body)));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  // How the Mini App looks for one's own organization (its background), for everyone in it.
  app.get(
    '/organization/appearance',
    { config: { permission: 'authenticated' } },
    async (req, reply) => {
      try {
        const { tenantId } = requirePrincipal(req);
        return reply.send(ok(await readOrganizationAppearance(deps.prisma, tenantId)));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  // The logo of one's own organization, for the Mini App: everyone reads it, an administrator
  // sets or removes it (the platform console can too).
  if (deps.storage) {
    const storage = deps.storage;
    app.get(
      '/organization/logo',
      { config: { permission: 'authenticated' } },
      async (req, reply) => {
        try {
          const { tenantId } = requirePrincipal(req);
          return reply.send(ok(await readOrganizationLogo(deps.prisma, storage, tenantId)));
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      },
    );
    app.post(
      '/organization/logo',
      { config: { permission: 'organization.manage' }, bodyLimit: 2 * LOGO_MAX_BYTES },
      async (req, reply) => {
        try {
          const auth = requirePermission(req, 'organization.manage').principal;
          const body = LogoBodySchema.parse(req.body);
          const logo = { contentType: body.contentType, data: Buffer.from(body.data, 'base64') };
          return reply.send(
            ok(
              await setOwnOrganizationLogo(deps.prisma, storage, auth.tenantId, logo, {
                userId: auth.userId,
              }),
            ),
          );
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      },
    );
    app.delete(
      '/organization/logo',
      { config: { permission: 'organization.manage' } },
      async (req, reply) => {
        try {
          const auth = requirePermission(req, 'organization.manage').principal;
          return reply.send(
            ok(
              await setOwnOrganizationLogo(deps.prisma, storage, auth.tenantId, null, {
                userId: auth.userId,
              }),
            ),
          );
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      },
    );
  }

  // Telegram Mini App: the assistant, the same conversation as the bot with the session's person.
  // Every command checks its own permission, as in the chat.
  if (deps.appChat) {
    const appChat = deps.appChat;
    app.post('/miniapp/chat', { config: { permission: 'practice.read' } }, async (req, reply) => {
      try {
        const auth = requirePermission(req, 'practice.read').principal;
        const body = AppChatBodySchema.parse(req.body);
        return reply.send(ok({ replies: await appChat.ask(auth, body.text) }));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    });
  }

  // Telegram Mini App: the «Oggi» and «Agenda» screens in one call, within the caller's grants.
  app.get('/miniapp/summary', { config: { permission: 'practice.read' } }, async (req, reply) => {
    try {
      const practices = requirePermission(req, 'practice.read');
      const deadlines = authorize(practices.principal, 'compliance.read');
      return reply.send(
        ok(
          await miniAppSummary(deps.prisma, deps.complianceService, {
            tenantId: practices.principal.tenantId,
            practiceUserId: scopedUserId(practices),
            deadlineUserId: scopedUserId(deadlines),
          }),
        ),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // AGX-07: the usage of the organization in a fixed period, with the part done by others
  // through a delegation. Who reads the activity log reads this too.
  app.get('/usage', { config: { permission: 'audit.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'audit.read').principal;
      const query = StatsQuerySchema.parse(req.query);
      return reply.send(
        ok(
          await organizationUsage(deps.prisma, {
            tenantId: auth.tenantId,
            kind: query.period,
            previous: query.previous,
          }),
        ),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  // The usage events of the period as a CSV file (one row each), for invoicing and checks.
  app.get('/usage/export', { config: { permission: 'audit.read' } }, async (req, reply) => {
    try {
      const auth = requirePermission(req, 'audit.read').principal;
      const query = StatsQuerySchema.parse(req.query);
      return reply.send(
        ok(
          await usageExport(deps.prisma, {
            tenantId: auth.tenantId,
            kind: query.period,
            previous: query.previous,
          }),
        ),
      );
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

  // --- Fase 1C: the company profile, by its administrators ----------------------------------
  app.get(
    '/organization/profile',
    { config: { permission: 'organization.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'organization.manage').principal;
        return reply.send(ok(await getCompanyProfile(deps.prisma, auth.tenantId)));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    '/organization/profile/versions',
    { config: { permission: 'organization.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'organization.manage').principal;
        return reply.send(ok(await listProfileVersions(deps.prisma, auth.tenantId)));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    '/organization/profile',
    { config: { permission: 'organization.manage' } },
    async (req, reply) => {
      try {
        const auth = requirePermission(req, 'organization.manage').principal;
        const body = ProfileBodySchema.parse(req.body);
        return reply.send(
          ok(
            await saveCompanyProfile(deps.prisma, {
              orgId: auth.tenantId,
              userId: auth.userId,
              source: 'ORGANIZATION',
              ...body,
            }),
          ),
        );
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  done();
};
