import { DatabaseError, NotFoundError } from '../errors/errors.js';
import { requireTenantId } from '../guard/tenant.js';

import type { PrismaLike } from '../types/prisma.js';
import type { OcrStatus } from '@prisma/client';

export type PracticeAttachmentDTO = {
  id: string;
  tenantId: string;
  practiceId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string;
  ocrStatus: OcrStatus;
  ocrResult: unknown;
  /** A1: the data confirmed by a person, and when; null until then. */
  validatedData: unknown;
  validatedAt: Date | null;
  /** AGX-05: the expected document of the practice's type this file is, if linked. */
  expectedKey: string | null;
  /** AGX-05: rejected by a person, with the reason (shown to whoever reaches the practice). */
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toAttachmentDTO(row: {
  id: string;
  tenantId: string;
  practiceId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string;
  ocrStatus: OcrStatus;
  ocrResult: unknown;
  validatedData?: unknown;
  validatedAt?: Date | null;
  expectedKey?: string | null;
  rejectedAt?: Date | null;
  rejectionReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PracticeAttachmentDTO {
  return {
    id: row.id,
    tenantId: row.tenantId,
    practiceId: row.practiceId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    storagePath: row.storagePath,
    ocrStatus: row.ocrStatus,
    ocrResult: row.ocrResult,
    validatedData: row.validatedData ?? null,
    validatedAt: row.validatedAt ?? null,
    expectedKey: row.expectedKey ?? null,
    rejectedAt: row.rejectedAt ?? null,
    rejectionReason: row.rejectionReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class AttachmentRepository {
  constructor(private readonly prisma: PrismaLike) {}

  async createAttachment(
    tenantId: string,
    data: {
      practiceId: string;
      fileName: string;
      mimeType: string;
      fileSize: number;
      storagePath: string;
      ocrStatus?: OcrStatus;
      ocrResult?: unknown;
      /** AGX-01: SHA-256 of the content. */
      contentHash?: string;
      /** AGX-05: checked by the caller against the module. */
      expectedKey?: string | null;
    },
  ): Promise<PracticeAttachmentDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.practiceAttachment.create({
        data: {
          tenantId,
          practiceId: data.practiceId,
          fileName: data.fileName,
          mimeType: data.mimeType,
          fileSize: data.fileSize,
          storagePath: data.storagePath,
          ocrStatus: data.ocrStatus ?? 'PENDING',
          ocrResult: data.ocrResult ? (data.ocrResult as never) : undefined,
          contentHash: data.contentHash,
          expectedKey: data.expectedKey ?? null,
        },
      });
      return toAttachmentDTO(row);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to create practice attachment', err);
    }
  }

  async getAttachmentById(tenantId: string, id: string): Promise<PracticeAttachmentDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.practiceAttachment.findFirst({
        where: { tenantId, id },
      });
      if (!row) throw new NotFoundError('Attachment not found');
      return toAttachmentDTO(row);
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      throw new DatabaseError('Failed to get practice attachment', err);
    }
  }

  async listAttachmentsByPractice(
    tenantId: string,
    practiceId: string,
  ): Promise<PracticeAttachmentDTO[]> {
    requireTenantId(tenantId);
    try {
      const rows = await this.prisma.practiceAttachment.findMany({
        where: { tenantId, practiceId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toAttachmentDTO);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to list practice attachments', err);
    }
  }

  async updateOcrResult(
    tenantId: string,
    id: string,
    data: {
      ocrStatus: OcrStatus;
      ocrResult?: unknown;
    },
  ): Promise<PracticeAttachmentDTO> {
    requireTenantId(tenantId);
    try {
      const row = await this.prisma.practiceAttachment.update({
        where: { id, tenantId },
        data: {
          ocrStatus: data.ocrStatus,
          ocrResult: data.ocrResult !== undefined ? (data.ocrResult as never) : undefined,
        },
      });
      return toAttachmentDTO(row);
    } catch (err: unknown) {
      throw new DatabaseError('Failed to update OCR result', err);
    }
  }

  async deleteAttachment(tenantId: string, id: string): Promise<void> {
    requireTenantId(tenantId);
    try {
      await this.prisma.practiceAttachment.deleteMany({
        where: { id, tenantId },
      });
    } catch (err: unknown) {
      throw new DatabaseError('Failed to delete practice attachment', err);
    }
  }
}
