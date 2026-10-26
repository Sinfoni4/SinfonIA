import { z } from 'zod';

export const PracticeStateSchema = z.enum([
  'CREATED',
  'VALIDATED',
  'SUBMITTED',
  'FAILED',
  'COMPLETED',
]);

export const PracticeKindSchema = z.enum(['artist', 'music', 'generic']);

export const PracticeIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const PracticeTransitionParamsSchema = PracticeIdParamsSchema;

export const PracticeTransitionBodySchema = z.object({
  nextState: PracticeStateSchema,
});

export const PracticeCreateBodySchema = z.object({
  name: z.string().trim().min(1, 'Practice name is required'),
  kind: PracticeKindSchema.default('generic'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PracticeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: PracticeStateSchema.optional(),
  userId: z.string().uuid().optional(),
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

export type PracticeTransitionParams = z.infer<typeof PracticeTransitionParamsSchema>;
export type PracticeTransitionBody = z.infer<typeof PracticeTransitionBodySchema>;
export type PracticeCreateBody = z.infer<typeof PracticeCreateBodySchema>;
export type PracticeListQuery = z.infer<typeof PracticeListQuerySchema>;
export type PracticeExportBody = z.infer<typeof PracticeExportBodySchema>;
