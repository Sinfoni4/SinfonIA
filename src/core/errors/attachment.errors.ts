export type AttachmentRejectionCode =
  'EMPTY_ATTACHMENT' | 'ATTACHMENT_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE';

const STATUS_BY_CODE: Record<AttachmentRejectionCode, number> = {
  EMPTY_ATTACHMENT: 400,
  ATTACHMENT_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

export class AttachmentRejectedError extends Error {
  readonly code: AttachmentRejectionCode;
  readonly statusCode: number;

  constructor(code: AttachmentRejectionCode, message: string) {
    super(message);
    this.name = 'AttachmentRejectedError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}

/**
 * AGX-01: the same file is already attached to this practice or to another practice of the
 * person. Sent again only after the person confirms (`allowDuplicate`).
 */
export class DuplicateAttachmentError extends Error {
  readonly code = 'DUPLICATE_ATTACHMENT';
  readonly statusCode = 409;

  constructor(
    readonly duplicate: {
      attachmentId: string;
      practiceId: string;
      practiceName: string;
      uploadedAt: Date;
    },
  ) {
    super(
      `Hai già caricato questo file il ${duplicate.uploadedAt.toLocaleDateString('it-IT', {
        timeZone: 'Europe/Rome',
      })} nella pratica «${duplicate.practiceName}».`,
    );
    this.name = 'DuplicateAttachmentError';
  }
}
