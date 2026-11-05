import { z } from 'zod';

import type { ComplianceCategory, PracticeStatus } from '@prisma/client';

/**
 * A02: the contract between the Core and the vertical modules (music, agriculture, ...).
 *
 * The Core owns the common practice states (CREATED, VALIDATED, SUBMITTED, COMPLETED, FAILED),
 * permissions, audit, documents and deadlines. A module only describes its sector on top of them
 * (A04/A05, reduced version): practice types with their fields, sub-states inside the common
 * states, expected documents, the deadline categories it uses and the instructions for the AI.
 *
 * A module is data, not code: it cannot add states, permissions or routes, and it imports nothing
 * from the Core except this file (checked by tests/a01.core-modules.test.ts).
 */

export const MODULE_IDS = ['generic', 'music', 'agri'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** One field of a practice type, stored under `payload.fields.<key>`. */
export type FieldDefinition = {
  /** camelCase key, unique within the practice type. */
  key: string;
  /** Label shown in the dashboard (Italian). */
  label: string;
  type: 'text' | 'number' | 'date' | 'choice';
  required?: boolean;
  /** text: maximum length (default 200). */
  maxLength?: number;
  /** number: bounds, inclusive. */
  min?: number;
  max?: number;
  /** choice: the allowed values. */
  options?: ReadonlyArray<{ value: string; label: string }>;
};

/** A finer step inside one or more of the common states (e.g. «integrazione richiesta»). */
export type SubStateDefinition = {
  key: string;
  label: string;
  /** The common states in which this sub-state can be set. */
  during: readonly PracticeStatus[];
};

/** A document the practice usually needs; a checklist, never a block on the states. */
export type ExpectedDocument = {
  key: string;
  label: string;
  required: boolean;
  /** When the document also has an expiry, the deadline category it belongs to. */
  deadlineCategory?: ComplianceCategory;
};

export type PracticeTypeDefinition = {
  /** Stable identifier stored in the payload (`payload.type = <kind>_practice`). */
  kind: string;
  /** Italian label for people. */
  label: string;
  /** Technical label kept for compatibility with the API (`typeLabel`). */
  typeLabel: string;
  /** Start of the one-line summary, followed by the practice name. */
  summaryPrefix: string;
  fields: readonly FieldDefinition[];
  subStates: readonly SubStateDefinition[];
  expectedDocuments: readonly ExpectedDocument[];
};

export type VerticalModule = {
  id: ModuleId;
  label: string;
  description: string;
  /** Kind used when the chat creates a practice without saying which. */
  defaultKind: string;
  practiceTypes: readonly PracticeTypeDefinition[];
  /** Deadline categories the organization can use; ALTRO is always allowed. */
  deadlineCategories: readonly ComplianceCategory[];
  /** Sector context added to the AI prompt; never personal data. */
  aiInstructions: string;
  /** First chat message after linking. */
  welcome: string;
};

/** Validation of the `fields` of one practice type, built from its definition. */
export function fieldsSchema(type: PracticeTypeDefinition) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of type.fields) {
    let schema: z.ZodType;
    switch (field.type) {
      case 'text':
        schema = z
          .string()
          .trim()
          .min(1)
          .max(field.maxLength ?? 200);
        break;
      case 'number': {
        let n = z.number().finite();
        if (field.min !== undefined) n = n.min(field.min);
        if (field.max !== undefined) n = n.max(field.max);
        schema = n;
        break;
      }
      case 'date':
        schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date YYYY-MM-DD');
        break;
      case 'choice': {
        const values = (field.options ?? []).map((o) => o.value);
        schema = z.string().refine((v) => values.includes(v), {
          message: `Allowed values: ${values.join(', ')}`,
        });
        break;
      }
    }
    shape[field.key] = field.required ? schema : schema.optional();
  }
  // Unknown fields are refused: what is stored is only what the module declares.
  return z.object(shape).strict();
}
