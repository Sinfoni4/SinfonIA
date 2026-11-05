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

/**
 * The stored values of a practice, as label and text to show, in the order the module declares
 * them: a choice by its label, a date as dd/mm/yyyy. Missing and undeclared values are left out.
 */
export function shownFields(
  type: PracticeType,
  values: Record<string, unknown> | undefined,
): Array<{ key: string; label: string; value: string }> {
  const out: Array<{ key: string; label: string; value: string }> = [];
  for (const field of type.fields) {
    const raw = values?.[field.key];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    let value = String(raw);
    if (field.type === 'choice') {
      value = field.options?.find((o) => o.value === raw)?.label ?? value;
    } else if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      value = value.split('-').reverse().join('/');
    }
    out.push({ key: field.key, label: field.label, value });
  }
  return out;
}

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
