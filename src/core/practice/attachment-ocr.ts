import type { DocumentOcrResult } from '../../ai/ocr/ocr.types.js';

/**
 * AGX-08: reading a document again in the background.
 *
 * On upload the document is read at once, as before, so a person in chat gets the data straight
 * away. When that read fails, the file stays «in attesa di lettura» (`PENDING`) and a job in the
 * outbox reads it again: it survives a restart, and the dispatcher retries it with backoff. After
 * OCR_MAX_ATTEMPTS failed attempts the file is `FAILED` and goes to the manual check (review
 * queue); whoever sent it from a chat hears the outcome either way.
 */

/** The background job: read the file of an attachment again. */
export const ATTACHMENT_OCR = 'ATTACHMENT_OCR';
/** The notice to whoever sent the file from a chat, once the background read is over. */
export const ATTACHMENT_READ = 'ATTACHMENT_READ';

export type AttachmentOcrPayload = {
  attachmentId: string;
  practiceId: string;
  /** Who sent the file. */
  userId: string;
  /** Where it came from: a chat channel gets a notice at the end. */
  channel: string | null;
  /** The organization that sent it through a delegation, for the usage events (AGX-07). */
  actorOrgId: string | null;
};

export type AttachmentReadPayload = {
  attachmentId: string;
  userId: string;
  outcome: 'COMPLETED' | 'FAILED';
};

export const DEFAULT_OCR_MAX_ATTEMPTS = 3;

/** Chat channels whose people hear the outcome of a background read. */
export const CHAT_CHANNELS: readonly string[] = ['telegram', 'whatsapp'];

/**
 * The practice payload with the file added to its list of attachments and its read data (the same
 * entry the upload writes when the first read succeeds). An entry already there is replaced.
 */
export function payloadWithReadAttachment(
  payload: unknown,
  attachment: { id: string; fileName: string; mimeType: string; createdAt: Date },
  ocrResult: DocumentOcrResult,
): Record<string, unknown> {
  const current =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const existing = Array.isArray(current.attachments) ? (current.attachments as unknown[]) : [];
  const others = existing.filter(
    (a) => !(a && typeof a === 'object' && (a as { id?: unknown }).id === attachment.id),
  );
  return {
    ...current,
    attachments: [
      ...others,
      {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        uploadedAt: attachment.createdAt.toISOString(),
        ocrStatus: 'COMPLETED',
        documentType: ocrResult.documentType,
        reviewRequired: ocrResult.reviewRequired,
      },
    ],
    lastOcrResult: ocrResult,
  };
}
