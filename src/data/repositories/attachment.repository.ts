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
