/**
 * Fase 1C: the company profile — the activities of a company and their details, as the
 * questionnaire of its sector asks. Written by its administrators, or by a delegate through a
 * delegation that covers it; checked only by a delegate.
 */
import { fieldValueLabel, type SectorField } from './sector';

import type { Organization } from './client';

export type ProfileActivity = {
  id: string;
  label: string;
  description: string;
  fields: readonly SectorField[];
};

export type ProfileDefinition = {
  edition: string;
  common: readonly SectorField[];
  activities: readonly ProfileActivity[];
};

export type ProfileData = {
  common: Record<string, unknown>;
  activities: Record<string, Record<string, unknown>>;
};

export type ProfileVersion = {
  version: number;
  activities: string[];
  data: ProfileData;
  source: 'ORGANIZATION' | 'DELEGATE';
  author: string | null;
  createdAt: string;
};

export type ProfileReview = {
  version: number;
  outcome: 'VERIFIED' | 'NEEDS_INFO';
  note: string | null;
  reviewer: string | null;
  createdAt: string;
};

export type CompanyProfile = {
  definition: ProfileDefinition;
  current: ProfileVersion | null;
  missing: string[];
  complete: boolean;
  review: ProfileReview | null;
  /** Through a delegation: whose profile it is and what the delegation allows. */
  delegation?: { grantorName: string; operations: string[]; validUntil: string };
};

export type ProfileHistoryItem = ProfileVersion & {
  reviews: Array<Omit<ProfileReview, 'version'>>;
};

/** Where the profile is reached: the company's own, or a delegation received. */
export type ProfileChannel = 'own' | { grantId: string };

export function profilePath(channel: ProfileChannel): string {
  return channel === 'own'
    ? '/organization/profile'
    : `/grants/${encodeURIComponent(channel.grantId)}/profile`;
}

const PROFILE_MODULES = ['agri'];
const PROFILE_TYPES = ['COMPANY', 'COOPERATIVE'];

/** Whether the organization has a company profile (its sector and its kind). */
export function hasCompanyProfile(org: Organization | undefined): boolean {
  return Boolean(
    org?.module &&
    PROFILE_MODULES.includes(org.module) &&
    org.type &&
    PROFILE_TYPES.includes(org.type),
  );
}

export const SOURCE_LABELS: Record<ProfileVersion['source'], string> = {
  ORGANIZATION: 'dall’azienda',
  DELEGATE: 'da un delegato',
};

export const OUTCOME_LABELS: Record<ProfileReview['outcome'], string> = {
  VERIFIED: 'Verificato',
  NEEDS_INFO: 'Servono informazioni',
};

/** Form values: one string per field, keyed `common.<key>` or `<activity>.<key>`. */
export type ProfileForm = { activities: string[]; values: Record<string, string> };

const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export function profileToForm(profile: ProfileVersion | null): ProfileForm {
  const values: Record<string, string> = {};
  if (!profile) return { activities: [], values };
  for (const [key, v] of Object.entries(profile.data.common ?? {}))
    values[`common.${key}`] = text(v);
  for (const [activity, answers] of Object.entries(profile.data.activities ?? {})) {
    for (const [key, v] of Object.entries(answers)) values[`${activity}.${key}`] = text(v);
  }
  return { activities: [...profile.activities], values };
}

function answers(
  fields: readonly SectorField[],
  prefix: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (values[`${prefix}.${f.key}`] ?? '').trim();
    if (raw === '') continue;
    out[f.key] = f.type === 'number' ? Number(raw.replace(',', '.')) : raw;
  }
  return out;
}

/** The form as the server expects it: only the activities chosen, numbers as numbers. */
export function formToProfile(
  definition: ProfileDefinition,
  form: ProfileForm,
): { activities: string[]; data: ProfileData } {
  const chosen = definition.activities.filter((a) => form.activities.includes(a.id));
  const activities: ProfileData['activities'] = {};
  for (const a of chosen) {
    const values = answers(a.fields, a.id, form.values);
    if (Object.keys(values).length > 0) activities[a.id] = values;
  }
  return {
    activities: chosen.map((a) => a.id),
    data: { common: answers(definition.common, 'common', form.values), activities },
  };
}

/** What a version changed from the one before, as people read it. */
export function profileChanges(
  definition: ProfileDefinition,
  before: ProfileVersion,
  after: ProfileVersion,
): string[] {
  const label = (id: string) => definition.activities.find((a) => a.id === id)?.label ?? id;
  const changes: string[] = [];
  for (const id of after.activities.filter((a) => !before.activities.includes(a))) {
    changes.push(`Aggiunta l’attività «${label(id)}»`);
  }
  for (const id of before.activities.filter((a) => !after.activities.includes(a))) {
    changes.push(`Tolta l’attività «${label(id)}»`);
  }
  const diff = (fields: readonly SectorField[], prefix: string, a: object, b: object) => {
    for (const f of fields) {
      const was = fieldValueLabel(f, (a as Record<string, unknown>)[f.key]);
      const now = fieldValueLabel(f, (b as Record<string, unknown>)[f.key]);
      if (was !== now) changes.push(`${prefix}${f.label}: ${was || '—'} → ${now || '—'}`);
    }
  };
  diff(definition.common, '', before.data.common ?? {}, after.data.common ?? {});
  for (const activity of definition.activities) {
    if (!after.activities.includes(activity.id) || !before.activities.includes(activity.id)) {
      continue;
    }
    diff(
      activity.fields,
      `${activity.label} · `,
      before.data.activities?.[activity.id] ?? {},
      after.data.activities?.[activity.id] ?? {},
    );
  }
  return changes;
}
