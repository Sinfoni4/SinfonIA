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
