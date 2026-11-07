import { z } from 'zod';

import {
  auditDelegatedUse,
  delegatedPracticeOwner,
  issueGrant,
  listIssuedGrants,
  listReceivedGrants,
  proposeBeneficiary,
  renewGrant,
  resolveDelegatedAccess,
  revokeGrant,
  setBeneficiary,
} from '../../../core/delegation/delegation.service.js';
import { validateAttachment } from '../../../core/practice/attachment-validation.js';
import {
  practiceChecklist,
  setAttachmentExpectedKey,
} from '../../../core/practice/document-checklist.js';
import { moduleOfTenant, setPracticeSubState } from '../../../core/practice/practice-module.js';
import { deadlineCategoriesOf } from '../../../modules/registry.js';
import { requirePermission } from '../auth/guards.js';
import { mapErrorToHttp } from '../errors/error-mapper.js';
import { fail, ok } from '../errors/http.errors.js';
import {
  AttachmentExpectedBodySchema,
  PracticeAttachmentQuerySchema,
  PracticeCreateBodySchema,
  PracticeExportBodySchema,
  PracticeListQuerySchema,
  PracticeSubStateBodySchema,
  PracticeTransitionBodySchema,
} from '../validation/practice.validation.js';

import { ValidationBodySchema } from './attachment-review.routes.js';
import { attachmentBodyLimit, readAttachmentUpload } from './attachment-upload.js';

import type { DelegatedAccess } from '../../../core/delegation/delegation.service.js';
import type { PracticeApplicationService } from '../../../core/practice/practice.application.service.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

export type DelegationRoutesDeps = {
  prisma: PrismaClient;
  practiceService: PracticeApplicationService;
};

const OPERATIONS = ['READ', 'CREATE', 'UPDATE', 'APPROVE', 'DELETE', 'EXPORT'] as const;
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // The delegation lasts until the end of the chosen day, Italian time.
  .transform((d) => new Date(`${d}T23:59:59+01:00`));

const IssueBodySchema = z
  .object({
    grantee: z.union([
      z.object({ orgId: z.string().trim().uuid() }).strict(),
      z.object({ email: z.string().trim().email().max(254) }).strict(),
    ]),
    operations: z.array(z.enum(OPERATIONS)).min(1).max(6),
    validUntil: DateSchema,
  })
  .strict();
const IdSchema = z.object({ id: z.string().uuid() });
const PracticeParamsSchema = z.object({ id: z.string().uuid(), practiceId: z.string().uuid() });
const AttachmentParamsSchema = PracticeParamsSchema.extend({ attachmentId: z.string().uuid() });
/** AGX-04: a practice opened through a delegation: name, kind and fields, never an owner. */
const DelegatedCreateBodySchema = PracticeCreateBodySchema.pick({
  name: true,
  kind: true,
  fields: true,
}).strict();
const RenewBodySchema = z.object({ validUntil: DateSchema }).strict();
const RevokeBodySchema = z.object({ reason: z.string().max(500).optional() }).strict();
const PersonBodySchema = z.object({ userId: z.string().uuid() }).strict();

/** What the dashboard shows of a delegation while working through it. */
function delegationView(a: DelegatedAccess) {
  return { grantorName: a.grantorName, operations: a.operations, validUntil: a.validUntil };
}

/** AGX-04: the kinds, fields and steps of the grantor's module, for creating and updating. */
async function moduleView(prisma: PrismaClient, orgId: string) {
  const module = await moduleOfTenant(prisma, orgId);
  return {
    id: module.id,
    label: module.label,
    description: module.description,
    defaultKind: module.defaultKind,
    practiceTypes: module.practiceTypes,
    deadlineCategories: deadlineCategoriesOf(module),
  };
}

function sendError(reply: FastifyReply, err: unknown) {
  const mapped = mapErrorToHttp(err);
  return reply.status(mapped.statusCode).send(fail(mapped.code, mapped.message));
}

/**
 * MF8 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2.4, D3): delegations given and received, and
 * the work on the practices of the grantor through a delegation. Every use is checked against
 * the delegation at each request and recorded in the log of the grantor.
 */
export const delegationRoutes: FastifyPluginCallback<DelegationRoutesDeps> = (app, deps, done) => {
  // --- the grantor -------------------------------------------------------------------------------

  app.get('/grants/issued', { config: { permission: 'grant.issue' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'grant.issue');
      return reply.send(ok(await listIssuedGrants(deps.prisma, grant.principal.tenantId)));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/grants', { config: { permission: 'grant.issue' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'grant.issue');
      const body = IssueBodySchema.parse(req.body);
      const created = await issueGrant(deps.prisma, {
        grantorOrgId: grant.principal.tenantId,
        actorUserId: grant.principal.userId,
        grantee: body.grantee,
        operations: body.operations,
        validUntil: body.validUntil,
      });
      return reply.status(201).send(ok(created));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/grants/:id/renew', { config: { permission: 'grant.issue' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'grant.issue');
      const { id } = IdSchema.parse(req.params);
      const body = RenewBodySchema.parse(req.body);
      await renewGrant(deps.prisma, {
        grantId: id,
        grantorOrgId: grant.principal.tenantId,
        actorUserId: grant.principal.userId,
        validUntil: body.validUntil,
      });
      return reply.send(ok({ renewed: true }));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post('/grants/:id/revoke', { config: { permission: 'grant.issue' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'grant.issue');
      const { id } = IdSchema.parse(req.params);
      const body = RevokeBodySchema.parse(req.body ?? {});
      await revokeGrant(deps.prisma, {
        grantId: id,
        grantorOrgId: grant.principal.tenantId,
        actorUserId: grant.principal.userId,
        reason: body.reason,
      });
      return reply.send(ok({ revoked: true }));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  for (const [path, approve] of [
    ['approve', true],
    ['remove', false],
  ] as const) {
    app.post(
      `/grants/:id/beneficiaries/${path}`,
      { config: { permission: 'grant.issue' } },
      async (req, reply) => {
        try {
          const grant = requirePermission(req, 'grant.issue');
          const { id } = IdSchema.parse(req.params);
          const body = PersonBodySchema.parse(req.body);
          await setBeneficiary(deps.prisma, {
            grantId: id,
            grantorOrgId: grant.principal.tenantId,
            actorUserId: grant.principal.userId,
            userId: body.userId,
            approve,
          });
          return reply.send(ok({ done: true }));
        } catch (err: unknown) {
          return sendError(reply, err);
        }
      },
    );
  }

  // --- the receiver ------------------------------------------------------------------------------

  app.get('/grants/received', { config: { permission: 'grant.use' } }, async (req, reply) => {
    try {
      const grant = requirePermission(req, 'grant.use');
      return reply.send(
        ok(
          await listReceivedGrants(deps.prisma, {
            userId: grant.principal.userId,
            orgId: grant.principal.tenantId,
          }),
        ),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/grants/:id/beneficiaries',
    { config: { permission: 'grant.beneficiaries' } },
    async (req, reply) => {
      try {
        const grant = requirePermission(req, 'grant.beneficiaries');
        const { id } = IdSchema.parse(req.params);
        const body = PersonBodySchema.parse(req.body);
        await proposeBeneficiary(deps.prisma, {
          grantId: id,
          granteeOrgId: grant.principal.tenantId,
          actorUserId: grant.principal.userId,
          userId: body.userId,
        });
        return reply.status(201).send(ok({ proposed: true }));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  // --- work on the data of the grantor -----------------------------------------------------------

  const access = (
    req: Parameters<typeof requirePermission>[0],
    grantId: string,
    operation: 'READ' | 'CREATE' | 'UPDATE' | 'EXPORT',
  ) => {
    const grant = requirePermission(req, 'grant.use');
    return resolveDelegatedAccess(deps.prisma, {
      grantId,
      userId: grant.principal.userId,
      currentOrgId: grant.principal.tenantId,
      operation,
    }).then((a) => ({ access: a, userId: grant.principal.userId }));
  };

  app.get('/grants/:id/practices', { config: { permission: 'grant.use' } }, async (req, reply) => {
    try {
      const { id } = IdSchema.parse(req.params);
      const query = PracticeListQuerySchema.parse(req.query);
      const { access: a, userId } = await access(req, id, 'READ');
      const result = await deps.practiceService.listPracticesPaginated({
        tenantId: a.grantorOrgId,
        status: query.status,
        search: query.search,
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });
      await auditDelegatedUse(deps.prisma, a, userId, 'list');
      return reply.send(
        ok({
          ...result,
          delegation: delegationView(a),
          module: await moduleView(deps.prisma, a.grantorOrgId),
        }),
      );
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get(
    '/grants/:id/practices/:practiceId',
    { config: { permission: 'grant.use' } },
    async (req, reply) => {
      try {
        const { id, practiceId } = PracticeParamsSchema.parse(req.params);
        const { access: a, userId } = await access(req, id, 'READ');
        const practice = await deps.practiceService.getPractice({
          tenantId: a.grantorOrgId,
          practiceId,
        });
        const attachments = await deps.practiceService.listAttachments({
          tenantId: a.grantorOrgId,
          practiceId,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'read', { practiceId });
        return reply.send(
          ok({
            ...practice,
            attachments,
            // AGX-05: what is still missing, to check or rejected.
            checklist: await practiceChecklist(deps.prisma, {
              tenantId: a.grantorOrgId,
              practiceId,
            }),
            delegation: delegationView(a),
            module: await moduleView(deps.prisma, a.grantorOrgId),
          }),
        );
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/grants/:id/practices/:practiceId/transition',
    { config: { permission: 'grant.use' } },
    async (req, reply) => {
      try {
        const { id, practiceId } = PracticeParamsSchema.parse(req.params);
        const body = PracticeTransitionBodySchema.parse(req.body);
        const { access: a, userId } = await access(req, id, 'UPDATE');
        const practice = await deps.practiceService.transitionPractice({
          tenantId: a.grantorOrgId,
          userId,
          practiceId,
          nextState: body.nextState,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'transition', {
          practiceId,
          to: body.nextState,
        });
        return reply.send(ok(practice));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  // AGX-04: opens a practice for the grantor. It belongs to whoever issued the delegation (or an
  // administrator of the grantor); the person who acted is recorded in both audit events.
  app.post('/grants/:id/practices', { config: { permission: 'grant.use' } }, async (req, reply) => {
    try {
      const { id } = IdSchema.parse(req.params);
      const body = DelegatedCreateBodySchema.parse(req.body);
      const { access: a, userId } = await access(req, id, 'CREATE');
      const owner = await delegatedPracticeOwner(deps.prisma, a);
      const practice = await deps.practiceService.createPractice({
        tenantId: a.grantorOrgId,
        userId: owner,
        actorUserId: userId,
        name: body.name,
        kind: body.kind,
        fields: body.fields,
      });
      await auditDelegatedUse(deps.prisma, a, userId, 'create', { practiceId: practice.id });
      return reply.status(201).send(ok(practice));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  app.get(
    '/grants/:id/practices/:practiceId/attachments/:attachmentId/download',
    { config: { permission: 'grant.use' } },
    async (req, reply) => {
      try {
        const { id, practiceId, attachmentId } = AttachmentParamsSchema.parse(req.params);
        const { access: a, userId } = await access(req, id, 'READ');
        const file = await deps.practiceService.downloadAttachment({
          tenantId: a.grantorOrgId,
          practiceId,
          attachmentId,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'download', { practiceId, attachmentId });
        // Same headers as the download of one's own documents: never cached, never rendered.
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
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/grants/:id/practices/:practiceId/attachments',
    {
      bodyLimit: attachmentBodyLimit(deps.practiceService.getMaxAttachmentBytes()),
      config: { permission: 'grant.use' },
    },
    async (req, reply) => {
      try {
        const { id, practiceId } = PracticeParamsSchema.parse(req.params);
        const { allowDuplicate } = PracticeAttachmentQuerySchema.parse(req.query);
        // The delegation is checked before the file is read.
        const { access: a, userId } = await access(req, id, 'UPDATE');
        const upload = await readAttachmentUpload(req);
        const result = await deps.practiceService.addAttachment({
          tenantId: a.grantorOrgId,
          userId,
          practiceId,
          ...upload,
          allowDuplicate,
          channel: 'delegation',
          delegated: true,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'upload', {
          practiceId,
          attachmentId: result.attachment.id,
        });
        return reply.status(201).send(ok(result));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/grants/:id/practices/:practiceId/attachments/:attachmentId/validation',
    { config: { permission: 'grant.use' } },
    async (req, reply) => {
      try {
        const { id, practiceId, attachmentId } = AttachmentParamsSchema.parse(req.params);
        const body = ValidationBodySchema.parse(req.body);
        const { access: a, userId } = await access(req, id, 'UPDATE');
        const result = await validateAttachment(deps.prisma, {
          tenantId: a.grantorOrgId,
          practiceId,
          attachmentId,
          actorUserId: userId,
          data: body,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'validation', {
          practiceId,
          attachmentId,
        });
        return reply.send(ok(result));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/grants/:id/practices/:practiceId/attachments/:attachmentId/expected',
    { config: { permission: 'grant.use' } },
    async (req, reply) => {
      try {
        const { id, practiceId, attachmentId } = AttachmentParamsSchema.parse(req.params);
        const body = AttachmentExpectedBodySchema.parse(req.body);
        const { access: a, userId } = await access(req, id, 'UPDATE');
        const result = await setAttachmentExpectedKey(deps.prisma, {
          tenantId: a.grantorOrgId,
          practiceId,
          attachmentId,
          expectedKey: body.expectedKey,
          actorUserId: userId,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'expected', { practiceId, attachmentId });
        return reply.send(ok(result));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/grants/:id/practices/:practiceId/sub-state',
    { config: { permission: 'grant.use' } },
    async (req, reply) => {
      try {
        const { id, practiceId } = PracticeParamsSchema.parse(req.params);
        const body = PracticeSubStateBodySchema.parse(req.body);
        const { access: a, userId } = await access(req, id, 'UPDATE');
        const result = await setPracticeSubState(deps.prisma, {
          tenantId: a.grantorOrgId,
          practiceId,
          subState: body.subState,
          actorUserId: userId,
        });
        await auditDelegatedUse(deps.prisma, a, userId, 'sub_state', { practiceId });
        return reply.send(ok(result));
      } catch (err: unknown) {
        return sendError(reply, err);
      }
    },
  );

  app.post('/grants/:id/export', { config: { permission: 'grant.use' } }, async (req, reply) => {
    try {
      const { id } = IdSchema.parse(req.params);
      const body = PracticeExportBodySchema.parse(req.body ?? {});
      const { access: a, userId } = await access(req, id, 'EXPORT');
      const exported = await deps.practiceService.exportPractices({
        tenantId: a.grantorOrgId,
        filter: body.filter,
        audit: { actorUserId: userId, channel: 'delegation' },
      });
      await auditDelegatedUse(deps.prisma, a, userId, 'export');
      return reply.send(ok(exported));
    } catch (err: unknown) {
      return sendError(reply, err);
    }
  });

  done();
};
