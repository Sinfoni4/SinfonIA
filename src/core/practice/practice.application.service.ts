import { defaultDocumentOcrService } from '../../ai/ocr/document-ocr.service.js';
import { NotFoundError } from '../../data/errors/errors.js';
import { AttachmentRepository } from '../../data/repositories/attachment.repository.js';
import { PracticeRepository } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { defaultStorageService, type StorageService } from '../../data/storage/storage.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { requireDatabase } from '../../runtime/runtime.guard.js';
import { authorize, scopedUserId, type Principal } from '../authz/authorization.service.js';
import { AttachmentRejectedError } from '../errors/attachment.errors.js';
import { PracticeWorkflow } from '../workflow/practice.workflow.js';

import { escapeCsvField, exportFilterRange, exportFilterTitle } from './practice.export.js';
import { readPracticePayload } from './practice.payload.js';

import type { ChatTransition, PracticeCommand } from './practice.commands.js';
import type { PracticeExportFilter } from './practice.export.js';
import type { PracticeKind, PracticePayloadKind } from './practice.payload.js';
import type { DocumentOcrService } from '../../ai/ocr/document-ocr.service.js';
import type { DocumentOcrResult } from '../../ai/ocr/ocr.types.js';
import type { DetectedFileKind } from '../../ai/ocr/text-extraction.js';
import type { PracticeAttachmentDTO } from '../../data/repositories/attachment.repository.js';
import type { PaginatedResult } from '../../data/repositories/practice.repository.js';
import type { PracticeDTO } from '../../data/types/domain.js';
import type { Permission } from '../authz/permissions.js';
import type { PracticeState } from '../types/workflow.types.js';
import type { PrismaClient } from '@prisma/client';

export type PracticeActor = Principal;

const COMMAND_PERMISSIONS: Record<PracticeCommand['type'], Permission> = {
  CREATE_PRACTICE: 'practice.create',
  LIST_PRACTICES: 'practice.read',
  GET_PRACTICE_STATUS: 'practice.read',
  DELETE_PRACTICE: 'practice.delete',
  EXPORT_PRACTICES: 'practice.export',
  LIST_ORG_PRACTICES: 'practice.read',
  GET_ORG_PRACTICE_STATUS: 'practice.read',
  TRANSITION_ORG_PRACTICE: 'practice.transition',
  CONFIRM_TRANSITION: 'practice.transition',
};

/** Practices per page of the organization list in chat. */
export const ORG_PRACTICES_PAGE_SIZE = 10;
// Practices matching a name looked at when searching the whole organization.
const ORG_NAME_LOOKUP_LIMIT = 50;

export type PracticeView = {
  id: string;
  tenantId: string;
  userId: string;
  status: PracticeState;
  version: number;
  schemaVersion: number;
  name: string;
  kind: PracticePayloadKind;
  typeLabel: string;
  summary: string;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type PracticePaginationParams = {
  tenantId: string;
  userId?: string;
  status?: PracticeState;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
};

export type PracticeExportResult = {
  filter: PracticeExportFilter;
  title: string;
  csv: string;
  /** Number of exported practices. */
  count: number;
};

// Practices read per query during an export.
const EXPORT_BATCH_SIZE = 1000;

export type PracticeCommandResult =
  | { type: 'created'; practice: PracticeView }
  | { type: 'list'; practices: PracticeView[] }
  | { type: 'status'; practice: PracticeView }
  | { type: 'deleted'; practice: PracticeView }
  | { type: 'export'; result: PracticeExportResult; send: boolean }
  /** `orgHint`: the caller may search the whole organization with an explicit request. */
  | { type: 'not_found'; name: string; orgHint?: boolean }
  | {
      type: 'org_list';
      practices: Array<PracticeView & { own: boolean }>;
      page: number;
      totalPages: number;
      total: number;
    }
  | { type: 'org_status'; practice: PracticeView; own: boolean }
  /** Several practices of the organization have that name: nothing is done. */
  | { type: 'ambiguous'; name: string; practices: PracticeView[] }
  /** The caller's permission covers only their own practices. */
  | { type: 'org_view_denied' }
  /** The practice belongs to someone else: the person confirms before the transition. */
  | { type: 'confirm_transition'; practice: PracticeView; nextState: ChatTransition }
  | { type: 'transitioned'; practice: PracticeView };

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// The stored MIME type comes from the detected content, never from the client declaration.
const MIME_BY_KIND: Record<DetectedFileKind, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  text: 'text/plain',
};

function toView(dto: PracticeDTO): PracticeView {
  const payload = readPracticePayload(dto.payload);
  const name = payload.name ?? `Pratica ${dto.id.slice(0, 8)}`;

  return {
    id: dto.id,
    tenantId: dto.tenantId,
    userId: dto.userId,
    status: dto.status,
    version: dto.version,
    schemaVersion: payload.schemaVersion,
    name,
    kind: payload.kind,
    typeLabel: payload.typeLabel,
    summary: payload.name ? payload.summary : `${payload.typeLabel} ${name}`,
    payload: dto.payload,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/**
 * Canonical application service for every practice use case.
 *
 * HTTP, Telegram and the scheduler are transport adapters: they must not
 * create or transition practices by themselves. This service is the only
 * write path and always uses a real persisted user.
 */
export class PracticeApplicationService {
  private readonly workflow: PracticeWorkflow;
  private readonly repository: PracticeRepository;
  private readonly attachmentRepository: AttachmentRepository;
  private readonly storageService: StorageService;
  private readonly ocrService: DocumentOcrService;

  private readonly maxAttachmentBytes: number;

  constructor(
    private readonly prisma: PrismaClient,
    options?: {
      storageService?: StorageService;
      ocrService?: DocumentOcrService;
      attachmentRepository?: AttachmentRepository;
      maxAttachmentBytes?: number;
    },
  ) {
    this.workflow = new PracticeWorkflow(prisma);
    this.repository = new PracticeRepository(prisma);
    this.attachmentRepository = options?.attachmentRepository ?? new AttachmentRepository(prisma);
    this.storageService = options?.storageService ?? defaultStorageService;
    this.ocrService = options?.ocrService ?? defaultDocumentOcrService;
    this.maxAttachmentBytes = options?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  getMaxAttachmentBytes(): number {
    return this.maxAttachmentBytes;
  }

  async createPractice(input: {
    tenantId: string;
    userId: string;
    name: string;
    kind?: PracticeKind;
    metadata?: Record<string, unknown>;
  }): Promise<PracticeView> {
    const name = input.name.trim();
    if (!name) throw new NotFoundError('Practice name is required');

    const dto = await this.workflow.createPractice({
      tenantId: input.tenantId,
      userId: input.userId,
      name,
      kind: input.kind ?? 'generic',
      metadata: input.metadata,
    });
    return toView(dto);
  }

  async transitionPractice(input: {
    tenantId: string;
    userId: string;
    practiceId: string;
    nextState: PracticeState;
  }): Promise<PracticeView> {
    const dto = await this.workflow.transitionPractice({
      tenantId: input.tenantId,
      userId: input.userId,
      practiceId: input.practiceId,
      nextState: input.nextState,
    });
    return toView(dto);
  }

  async listPractices(input: {
    tenantId: string;
    userId?: string;
    status?: PracticeState;
    search?: string;
    limit?: number;
  }): Promise<PracticeView[]> {
    requireDatabase();

    const rows = await this.repository.listPractices(input.tenantId, {
      userId: input.userId,
      status: input.status,
      search: input.search,
      ...(typeof input.limit === 'number' && input.limit > 0 ? { limit: input.limit } : {}),
    });
    return rows.map(toView);
  }

  async listPracticesPaginated(
    input: PracticePaginationParams,
  ): Promise<PaginatedResult<PracticeView>> {
    requireDatabase();

    const result = await this.repository.findPracticesPaginated(input.tenantId, {
      userId: input.userId,
      status: input.status,
      search: input.search,
      page: input.page,
      limit: input.limit,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
    });

    return {
      items: result.items.map(toView),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async getPractice(input: {
    tenantId: string;
    practiceId: string;
    userId?: string;
  }): Promise<PracticeView> {
    requireDatabase();

    const dto = await this.repository.getPracticeById(input.tenantId, input.practiceId);
    if (input.userId && dto.userId !== input.userId) {
      throw new NotFoundError('Practice not found');
    }
    return toView(dto);
  }

  async deletePractice(input: {
    tenantId: string;
    practiceId: string;
    userId?: string;
  }): Promise<PracticeView> {
    requireDatabase();

    return withTransaction(this.prisma, async (tx) => {
      const repository = new PracticeRepository(tx);
      const audit = new AuditService(tx);

      const dto = await repository.getPracticeById(input.tenantId, input.practiceId);
      if (input.userId && dto.userId !== input.userId) {
        throw new NotFoundError('Practice not found');
      }

      await repository.deletePracticeById(input.tenantId, input.practiceId);
      await audit.logEvent({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        eventType: 'PRACTICE_DELETED',
        payload: { practiceId: input.practiceId },
      });

      return toView(dto);
    });
  }

  async addAttachment(input: {
    tenantId: string;
    userId: string;
    practiceId: string;
    fileName: string;
    mimeType: string;
    content: Buffer | Uint8Array;
    hint?: string;
  }): Promise<{
    attachment: PracticeAttachmentDTO;
    practice: PracticeView;
    ocrResult?: DocumentOcrResult;
  }> {
    requireDatabase();

    const practice = await this.getPractice({
      tenantId: input.tenantId,
      practiceId: input.practiceId,
      userId: input.userId,
    });

    const mimeType = this.validateAttachment(input.content);

    const storageResult = await this.storageService.save(
      input.tenantId,
      input.fileName,
      input.content,
      mimeType,
    );

    let ocrStatus: 'COMPLETED' | 'FAILED' = 'COMPLETED';
    let ocrResult: DocumentOcrResult | undefined;
    try {
      ocrResult = await this.ocrService.processDocument(
        input.content,
        mimeType,
        input.fileName,
        input.hint,
      );
    } catch {
      ocrStatus = 'FAILED';
    }

    let attachment: PracticeAttachmentDTO;
    try {
      attachment = await this.attachmentRepository.createAttachment(input.tenantId, {
        practiceId: input.practiceId,
        fileName: input.fileName,
        mimeType,
        fileSize: storageResult.fileSize,
        storagePath: storageResult.storagePath,
        ocrStatus,
        ocrResult,
      });
    } catch (err: unknown) {
      // Without its record the stored file could never be listed or deleted: remove it.
      await this.storageService
        .delete(input.tenantId, storageResult.storagePath)
        .catch(() => undefined);
      throw err;
    }

    let updatedPractice = practice;
    if (ocrResult) {
      const currentPayload =
        practice.payload && typeof practice.payload === 'object'
          ? (practice.payload as Record<string, unknown>)
          : {};

      const existingAttachments = Array.isArray(currentPayload.attachments)
        ? (currentPayload.attachments as unknown[])
        : [];

      const enrichedPayload = {
        ...currentPayload,
        attachments: [
          ...existingAttachments,
          {
            id: attachment.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            uploadedAt: attachment.createdAt.toISOString(),
            ocrStatus,
            documentType: ocrResult.documentType,
            reviewRequired: ocrResult.reviewRequired,
          },
        ],
        lastOcrResult: ocrResult,
      };

      const updatedDto = await this.repository.updatePracticePayload(
        input.tenantId,
        input.practiceId,
        enrichedPayload,
      );
      updatedPractice = toView(updatedDto);
    }

    return {
      attachment,
      practice: updatedPractice,
      ocrResult,
    };
  }

  /** Enforces size and format limits; returns the MIME type detected from the content. */
  private validateAttachment(content: Buffer | Uint8Array): string {
    if (content.length === 0) {
      throw new AttachmentRejectedError('EMPTY_ATTACHMENT', 'The attached file is empty');
    }
    if (content.length > this.maxAttachmentBytes) {
      const maxMb = Math.round((this.maxAttachmentBytes / 1024 / 1024) * 10) / 10;
      throw new AttachmentRejectedError(
        'ATTACHMENT_TOO_LARGE',
        `The attached file exceeds the ${maxMb} MB limit`,
      );
    }
    const kind = this.ocrService.detectFileKind(content);
    if (!kind) {
      throw new AttachmentRejectedError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Unsupported file format: allowed formats are PDF, JPEG, PNG, WEBP and plain text',
      );
    }
    return MIME_BY_KIND[kind];
  }

  async listAttachments(input: {
    tenantId: string;
    practiceId: string;
    userId?: string;
  }): Promise<PracticeAttachmentDTO[]> {
    requireDatabase();

    await this.getPractice({
      tenantId: input.tenantId,
      practiceId: input.practiceId,
      userId: input.userId,
    });

    return this.attachmentRepository.listAttachmentsByPractice(input.tenantId, input.practiceId);
  }

  /**
   * The file of an attachment, with the same access check as the practice (own-scoped callers
   * only reach their own practices). The attachment must belong to that practice.
   */
  async downloadAttachment(input: {
    tenantId: string;
    practiceId: string;
    attachmentId: string;
    userId?: string;
  }): Promise<{ fileName: string; mimeType: string; content: Buffer }> {
    requireDatabase();
    await this.getPractice({
      tenantId: input.tenantId,
      practiceId: input.practiceId,
      userId: input.userId,
    });
    const attachment = await this.attachmentRepository.getAttachmentById(
      input.tenantId,
      input.attachmentId,
    );
    if (attachment.practiceId !== input.practiceId) {
      throw new NotFoundError('Attachment not found');
    }
    const content = await this.storageService.read(input.tenantId, attachment.storagePath);
    return { fileName: attachment.fileName, mimeType: attachment.mimeType, content };
  }

  /**
   * CSV export of a tenant's (or a user's) practices. Read from the database in batches with the
   * date filter applied in the query, and without payloads, so memory does not grow with the
   * number or size of the practices (10,000 practices are covered by a test).
   */
  async exportPractices(input: {
    tenantId: string;
    userId?: string;
    filter: PracticeExportFilter;
    /** Manual exports are audited (D5): who, through which channel, what perimeter, how many. */
    audit?: { actorUserId: string; channel: string };
  }): Promise<PracticeExportResult> {
    requireDatabase();
    const range = exportFilterRange(input.filter);
    const lines: string[] = [];
    let after: { createdAt: Date; id: string } | undefined;

    for (;;) {
      const batch = await this.repository.findExportBatch(input.tenantId, {
        userId: input.userId,
        ...range,
        ...(after ? { after } : {}),
        take: EXPORT_BATCH_SIZE,
      });
      for (const row of batch) {
        const name = row.name?.trim() || `Pratica ${row.id.slice(0, 8)}`;
        lines.push(`${escapeCsvField(name)},${escapeCsvField(row.createdAt.toISOString())}`);
      }
      if (batch.length < EXPORT_BATCH_SIZE) break;
      const last = batch[batch.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
    }

    if (input.audit) {
      await new AuditService(this.prisma).logEvent({
        tenantId: input.tenantId,
        userId: input.audit.actorUserId,
        eventType: 'EXPORT_GENERATED',
        payload: {
          channel: input.audit.channel,
          scope: input.userId ? 'own' : 'tenant',
          filter: input.filter,
          rows: lines.length,
        },
      });
    }

    return {
      filter: input.filter,
      title: exportFilterTitle(input.filter),
      csv: lines.length === 0 ? '' : `Nome,Data Creazione\n${lines.join('\n')}\n`,
      count: lines.length,
    };
  }

  async executeCommand(
    command: PracticeCommand,
    actor: PracticeActor,
    /** Channel of the request, recorded in the audit of exports. */
    options: { channel?: string } = {},
  ): Promise<PracticeCommandResult> {
    const grant = authorize(actor, COMMAND_PERMISSIONS[command.type]);
    // Default view (C2): text commands work on the actor's own practices; the organization only
    // through the explicit commands below, and never beyond the permission.
    switch (command.type) {
      case 'CREATE_PRACTICE':
        return {
          type: 'created',
          practice: await this.createPractice({
            tenantId: actor.tenantId,
            userId: actor.userId,
            name: command.payload.name,
            kind: 'music',
          }),
        };

      case 'LIST_PRACTICES':
        return {
          type: 'list',
          practices: await this.listPractices({
            tenantId: actor.tenantId,
            userId: actor.userId,
          }),
        };

      case 'GET_PRACTICE_STATUS': {
        const practice = await this.findPracticeByName(actor, command.payload.name);
        return practice
          ? { type: 'status', practice }
          : {
              type: 'not_found',
              name: command.payload.name,
              ...(grant.scope === 'tenant' ? { orgHint: true } : {}),
            };
      }

      case 'LIST_ORG_PRACTICES': {
        if (grant.scope !== 'tenant') return { type: 'org_view_denied' };
        const page = await this.listPracticesPaginated({
          tenantId: actor.tenantId,
          page: command.payload.page,
          limit: ORG_PRACTICES_PAGE_SIZE,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
        });
        return {
          type: 'org_list',
          practices: page.items.map((p) => ({ ...p, own: p.userId === actor.userId })),
          page: page.page,
          totalPages: page.totalPages,
          total: page.total,
        };
      }

      case 'GET_ORG_PRACTICE_STATUS': {
        if (grant.scope !== 'tenant') return { type: 'org_view_denied' };
        const found = await this.findOrgPracticesByName(actor, command.payload.name);
        if (found.length === 0) return { type: 'not_found', name: command.payload.name };
        if (found.length > 1) {
          return { type: 'ambiguous', name: command.payload.name, practices: found };
        }
        return { type: 'org_status', practice: found[0], own: found[0].userId === actor.userId };
      }

      case 'TRANSITION_ORG_PRACTICE': {
        if (grant.scope !== 'tenant') return { type: 'org_view_denied' };
        const found = await this.findOrgPracticesByName(actor, command.payload.name);
        if (found.length === 0) return { type: 'not_found', name: command.payload.name };
        if (found.length > 1) {
          return { type: 'ambiguous', name: command.payload.name, practices: found };
        }
        const practice = found[0];
        if (practice.userId !== actor.userId) {
          return { type: 'confirm_transition', practice, nextState: command.payload.nextState };
        }
        return {
          type: 'transitioned',
          practice: await this.transitionPractice({
            tenantId: actor.tenantId,
            userId: actor.userId,
            practiceId: practice.id,
            nextState: command.payload.nextState,
          }),
        };
      }

      case 'CONFIRM_TRANSITION': {
        // Checked again at confirmation: the role or the practice may have changed meanwhile.
        await this.getPractice({
          tenantId: actor.tenantId,
          practiceId: command.payload.practiceId,
          userId: scopedUserId(grant),
        });
        return {
          type: 'transitioned',
          practice: await this.transitionPractice({
            tenantId: actor.tenantId,
            userId: actor.userId,
            practiceId: command.payload.practiceId,
            nextState: command.payload.nextState,
          }),
        };
      }

      case 'DELETE_PRACTICE': {
        const practice = await this.findPracticeByName(actor, command.payload.name);
        if (!practice) {
          return { type: 'not_found', name: command.payload.name };
        }

        return {
          type: 'deleted',
          practice: await this.deletePractice({
            tenantId: actor.tenantId,
            practiceId: practice.id,
            userId: actor.userId,
          }),
        };
      }

      case 'EXPORT_PRACTICES':
        return {
          type: 'export',
          // D5: an export by text command is always of the caller's own practices.
          result: await this.exportPractices({
            tenantId: actor.tenantId,
            userId: actor.userId,
            filter: command.payload.filter,
            audit: { actorUserId: actor.userId, channel: options.channel ?? 'api' },
          }),
          send: command.payload.send,
        };
    }
  }

  /** Practices of the whole organization with exactly that name (case-insensitive). */
  private async findOrgPracticesByName(
    actor: PracticeActor,
    name: string,
  ): Promise<PracticeView[]> {
    const needle = name.trim().toLowerCase();
    if (!needle) return [];
    const practices = await this.listPractices({
      tenantId: actor.tenantId,
      search: name.trim(),
      limit: ORG_NAME_LOOKUP_LIMIT,
    });
    return practices.filter((practice) => practice.name.toLowerCase() === needle);
  }

  private async findPracticeByName(
    actor: PracticeActor,
    name: string,
  ): Promise<PracticeView | null> {
    const needle = name.trim().toLowerCase();
    if (!needle) return null;

    const practices = await this.listPractices({
      tenantId: actor.tenantId,
      userId: actor.userId,
    });
    return practices.find((practice) => practice.name.toLowerCase() === needle) ?? null;
  }
}
