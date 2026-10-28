import { z } from 'zod';

import { COMPLIANCE_CATEGORIES } from '../../../core/compliance/compliance.service.js';

export const ComplianceCategorySchema = z.enum(COMPLIANCE_CATEGORIES);

export const ComplianceDeadlineParamsSchema = z.object({
  id: z.string().uuid(),
});

export const ComplianceDeadlineCreateBodySchema = z.object({
  category: ComplianceCategorySchema,
  title: z.string().trim().min(1, 'Title is required').max(200),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dueDate must be YYYY-MM-DD'),
  // Member the deadline refers to (e.g. a medical check); omitted = the cooperative.
  userId: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const ComplianceDeadlineListQuerySchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  category: ComplianceCategorySchema.optional(),
  userId: z.string().uuid().optional(),
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
