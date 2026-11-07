import { z } from 'zod';

import { PRACTICE_KINDS } from '../../../modules/registry.js';

export const PracticeStateSchema = z.enum([
  'CREATED',
  'VALIDATED',
  'SUBMITTED',
  'FAILED',
  'COMPLETED',
]);

export const PracticeKindSchema = z.enum(PRACTICE_KINDS);

export const PracticeIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const PracticeTransitionParamsSchema = PracticeIdParamsSchema;

export const PracticeTransitionBodySchema = z.object({
  nextState: PracticeStateSchema,
});

export const PracticeCreateBodySchema = z.object({
  name: z.string().trim().min(1, 'Practice name is required'),
  /** Omitted: the default kind of the organization's module (A02). */
  kind: PracticeKindSchema.optional(),
  /** A04: the fields of the kind, checked against its module. */
  fields: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** AGX-03: the person the practice is opened for; needs `practice.assign`. */
  holderUserId: z.string().uuid().nullable().optional(),
});

/** A05: a sub-state of the practice type, or null to clear it. */
export const PracticeSubStateBodySchema = z.object({
  subState: z.string().trim().min(1).max(60).nullable(),
});

export const PracticeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: PracticeStateSchema.optional(),
  userId: z.string().uuid().optional(),
  /** A4: `me`, `none` (followed by nobody) or a person. */
  assignedTo: z.union([z.literal('me'), z.literal('none'), z.string().uuid()]).optional(),
  search: z.string().trim().optional(),
  sortBy: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const PracticeExportBodySchema = z.object({
  filter: z
    .union([
      z.object({ type: z.literal('all') }),
      z.object({ type: z.literal('today') }),
      z.object({ type: z.literal('month') }),
      z.object({ type: z.literal('year'), value: z.number().int() }),
    ])
    .default({ type: 'all' }),
});

export const PracticeAssignBodySchema = z.object({ userId: z.string().uuid().nullable() }).strict();

/** AGX-03: the holder of a practice, or null to give it back to its creator. */
export const PracticeHolderBodySchema = z.object({ userId: z.string().uuid().nullable() }).strict();

export const PracticeAttachmentParamsSchema = PracticeIdParamsSchema;

/** AGX-01: `?allowDuplicate=true` sends a file already sent, after the person confirmed. */
export const PracticeAttachmentQuerySchema = z.object({
  allowDuplicate: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const PracticeAttachmentBodySchema = z.object({
  fileName: z.string().trim().min(1, 'File name is required'),
  mimeType: z.string().trim().min(1).default('application/octet-stream'),
  contentBase64: z.string().min(1, 'File content (base64) is required'),
  hint: z.string().optional(),
  /** AGX-05: the expected document of the practice's type this file is. */
  expectedKey: z.string().trim().min(1).max(60).optional(),
  /** AGX-06: the open request this file answers. */
  requestId: z.string().uuid().optional(),
});

/** AGX-06: a request for a document: an expected one (or anything, with no key) and why. */
export const DocumentRequestBodySchema = z
  .object({
    expectedKey: z.string().trim().min(1).max(60).nullable().optional(),
    message: z.string().trim().min(3).max(1000),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict();

export const DocumentRequestParamsSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
});

/** AGX-06: staff link a file of the practice to an open request. */
export const DocumentRequestFulfilBodySchema = z
  .object({ attachmentId: z.string().uuid() })
  .strict();

/** AGX-05: links a file to an expected document of the practice, or unlinks it (null). */
export const AttachmentExpectedBodySchema = z
  .object({ expectedKey: z.string().trim().min(1).max(60).nullable() })
  .strict();

/** AGX-05: a rejection always says why. */
export const AttachmentRejectionBodySchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export type PracticeTransitionParams = z.infer<typeof PracticeTransitionParamsSchema>;
export type PracticeTransitionBody = z.infer<typeof PracticeTransitionBodySchema>;
export type PracticeCreateBody = z.infer<typeof PracticeCreateBodySchema>;
export type PracticeListQuery = z.infer<typeof PracticeListQuerySchema>;
export type PracticeExportBody = z.infer<typeof PracticeExportBodySchema>;
export type PracticeAttachmentParams = z.infer<typeof PracticeAttachmentParamsSchema>;
export type PracticeAttachmentBody = z.infer<typeof PracticeAttachmentBodySchema>;
