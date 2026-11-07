import { AttachmentRejectedError } from '../../../core/index.js';
import { PracticeAttachmentBodySchema } from '../validation/practice.validation.js';

import type { FastifyRequest } from 'fastify';

/**
 * Reading an uploaded document, shared by the routes of one's own practices and those used
 * through a delegation (AGX-04): multipart/form-data (field "file", optional "hint") or JSON with
 * the content in base64.
 */
export type AttachmentUpload = {
  fileName: string;
  mimeType: string;
  content: Buffer;
  hint?: string;
};

// Room for the JSON envelope around the base64 content (file name, MIME type, hint).
const BASE64_ENVELOPE_BYTES = 64 * 1024;

/** The body limit of an upload route: the file in base64 plus its envelope. */
export function attachmentBodyLimit(maxAttachmentBytes: number): number {
  return Math.ceil((maxAttachmentBytes * 4) / 3) + BASE64_ENVELOPE_BYTES;
}

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

export function readAttachmentUpload(req: FastifyRequest): Promise<AttachmentUpload> {
  return req.isMultipart() ? readMultipartUpload(req) : Promise.resolve(readBase64Upload(req.body));
}
