/** A02: the sector module of the current organization, as GET /modules/current returns it. */

import type { PracticeState } from './practices';

export type FieldDefinition = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'choice';
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
};

export type PracticeType = {
  kind: string;
  label: string;
  typeLabel: string;
  fields: FieldDefinition[];
  subStates: Array<{ key: string; label: string; during: PracticeState[] }>;
  expectedDocuments: Array<{ key: string; label: string; required: boolean }>;
};

export type CurrentModule = {
  id: string;
  label: string;
  description: string;
  defaultKind: string;
  practiceTypes: PracticeType[];
  deadlineCategories: string[];
};

/** Used while the module is loading or when the server does not have it (older backend). */
export const FALLBACK_MODULE: CurrentModule = {
  id: 'generic',
  label: 'Generico',
  description: '',
  defaultKind: 'generic',
  practiceTypes: [
    {
      kind: 'generic',
      label: 'Generica',
      typeLabel: 'generic practice',
      fields: [],
      subStates: [],
      expectedDocuments: [],
    },
  ],
  deadlineCategories: [],
};

/** The values typed in a form, converted to what the API checks (numbers as numbers). */
export function fieldValues(
  type: PracticeType,
  values: Record<string, string>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const field of type.fields) {
    const raw = values[field.key]?.trim();
    if (!raw) continue;
    out[field.key] = field.type === 'number' ? Number(raw) : raw;
  }
  return out;
}
