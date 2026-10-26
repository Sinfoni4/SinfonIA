import { z } from 'zod';

const PracticeStateSchema = z.enum(['CREATED', 'VALIDATED', 'SUBMITTED', 'FAILED', 'COMPLETED']);

export const PracticeTransitionParamsSchema = z.object({
  id: z.string().uuid(),
});

export const PracticeTransitionBodySchema = z.object({
  nextState: PracticeStateSchema,
});

export type PracticeTransitionParams = z.infer<typeof PracticeTransitionParamsSchema>;
export type PracticeTransitionBody = z.infer<typeof PracticeTransitionBodySchema>;
