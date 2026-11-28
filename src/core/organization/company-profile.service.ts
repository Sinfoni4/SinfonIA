import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import {
  profileDefinitionOf,
  type CompanyProfileDefinition,
  type ProfileActivity,
} from '../../modules/registry.js';
import { fieldListSchema, type FieldDefinition } from '../modules/module.contract.js';

import type {
  OrganizationType,
  Prisma,
  PrismaClient,
  ProfileReviewOutcome,
  ProfileSource,
} from '@prisma/client';

/**
 * Fase 1C: the profile of a company — its activities (several at once) and their details, as the
 * questionnaire of its sector asks (src/modules/agri-profile.ts).
 *
 * - Every save is a new version, never changed afterwards; the history shows who wrote each one,
 *   the company itself or a delegate (through a delegation that includes the profile).
 * - A field marked required never blocks saving: it makes the profile «incompleto».
 * - Only a delegate checks a profile («verificato» or «servono informazioni»), never the company.
 * - Nothing is activated from a profile: the catalog of modules (Fase 1D) will only suggest.
 */

export class CompanyProfileError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 = 400,
    readonly code = 'COMPANY_PROFILE_INVALID',
  ) {
    super(message);
    this.name = 'CompanyProfileError';
  }
}

/** The kinds of organization that have a company profile. */
const PROFILE_TYPES: readonly OrganizationType[] = ['COMPANY', 'COOPERATIVE'];

export type ProfileData = {
  common: Record<string, unknown>;
  activities: Record<string, Record<string, unknown>>;
};

export type ProfileVersionView = {
  version: number;
  activities: string[];
  data: ProfileData;
  source: ProfileSource;
  author: string | null;
  createdAt: string;
};

export type ProfileReviewView = {
  version: number;
  outcome: ProfileReviewOutcome;
  note: string | null;
  reviewer: string | null;
  createdAt: string;
};

export type CompanyProfileView = {
  definition: CompanyProfileDefinition;
  current: ProfileVersionView | null;
  /** The labels of the required answers still missing; empty when complete. */
  missing: string[];
  complete: boolean;
  /** The latest check of the current version, if any. */
  review: ProfileReviewView | null;
};

const NOTE_MIN = 3;
const NOTE_MAX = 500;
const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

function authorLabel(user: { id: string; email: string } | null): string | null {
  if (!user) return null;
  return PLACEHOLDER_EMAIL.test(user.email)
    ? `Account solo chat (…${user.id.slice(-4)})`
    : user.email;
}

/** The questionnaire of the organization, or why it has none. */
export async function profileDefinitionFor(
  prisma: Pick<PrismaClient, 'tenant'>,
  orgId: string,
): Promise<CompanyProfileDefinition> {
  const org = await prisma.tenant.findUnique({
    where: { id: orgId },
    select: { module: true, type: true },
  });
  if (!org) throw new NotFoundError('Organization not found');
  const definition = profileDefinitionOf(org.module);
  if (!definition || !PROFILE_TYPES.includes(org.type)) {
    throw new CompanyProfileError(
      'Il profilo aziendale non è previsto per questa organizzazione',
      404,
      'PROFILE_NOT_AVAILABLE',
    );
  }
  return definition;
}

/** Whether the organization has a company profile (its sector and its kind). */
export function profileApplies(org: { module: string; type: OrganizationType }): boolean {
  return Boolean(profileDefinitionOf(org.module)) && PROFILE_TYPES.includes(org.type);
}

/** All the fields optional: a required field makes the profile incomplete, never invalid. */
function lenient(fields: readonly FieldDefinition[]): FieldDefinition[] {
  return fields.map((field) => ({ ...field, required: false }));
}

function checkFields(fields: readonly FieldDefinition[], value: unknown, where: string) {
  const parsed = fieldListSchema(lenient(fields)).safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fields.find((f) => f.key === issue?.path[0]);
    throw new CompanyProfileError(
      field ? `${where}: campo «${field.label}» non valido` : `${where}: dati non validi`,
    );
  }
  return parsed.data;
}

/** The activities and answers sent, checked against the questionnaire. */
export function validateProfile(
  definition: CompanyProfileDefinition,
  input: { activities: unknown; data: unknown },
): { activities: string[]; data: ProfileData } {
  if (!Array.isArray(input.activities)) {
    throw new CompanyProfileError('Indica le attività dell’azienda');
  }
  const byId = new Map(definition.activities.map((a) => [a.id, a]));
  const activities = [...new Set(input.activities as unknown[])];
  for (const id of activities) {
    if (typeof id !== 'string' || !byId.has(id)) {
      throw new CompanyProfileError(`Attività sconosciuta: ${String(id)}`);
    }
  }
  const chosen = definition.activities.map((a) => a.id).filter((id) => activities.includes(id));
  const raw = (input.data ?? {}) as { common?: unknown; activities?: unknown };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CompanyProfileError('Dati del profilo non validi');
  }
  const extra = Object.keys(raw).filter((k) => k !== 'common' && k !== 'activities');
  if (extra.length > 0) throw new CompanyProfileError('Dati del profilo non validi');
  const common = checkFields(definition.common, raw.common, 'Dati generali');
  const sent = (raw.activities ?? {}) as Record<string, unknown>;
  if (typeof sent !== 'object' || Array.isArray(sent)) {
    throw new CompanyProfileError('Dati delle attività non validi');
  }
  for (const id of Object.keys(sent)) {
    if (!chosen.includes(id)) {
      throw new CompanyProfileError(`Dettagli di un’attività non indicata: ${id}`);
    }
  }
  const details: ProfileData['activities'] = {};
  for (const id of chosen) {
    const activity = byId.get(id) as ProfileActivity;
    const value = checkFields(activity.fields, sent[id], activity.label);
    if (Object.keys(value).length > 0) details[id] = value;
  }
  return { activities: chosen, data: { common, activities: details } };
}

/** The required answers still missing, as «Section: field». */
export function missingAnswers(
  definition: CompanyProfileDefinition,
  profile: { activities: string[]; data: ProfileData } | null,
): string[] {
  if (!profile || profile.activities.length === 0) return ['Attività dell’azienda'];
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const missing = definition.common
    .filter((f) => f.required && empty(profile.data.common?.[f.key]))
    .map((f) => `Dati generali: ${f.label}`);
  for (const activity of definition.activities) {
    if (!profile.activities.includes(activity.id)) continue;
    const answers = profile.data.activities?.[activity.id] ?? {};
    for (const f of activity.fields) {
      if (f.required && empty(answers[f.key])) missing.push(`${activity.label}: ${f.label}`);
    }
  }
  return missing;
}

/** The same JSON whatever the order of the keys (PostgreSQL reorders them in jsonb). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const VERSION_SELECT = {
  id: true,
  version: true,
  activities: true,
  data: true,
  source: true,
  createdAt: true,
  author: { select: { id: true, email: true } },
} as const satisfies Prisma.CompanyProfileVersionSelect;

type VersionRow = Prisma.CompanyProfileVersionGetPayload<{ select: typeof VERSION_SELECT }>;

function readData(value: unknown): ProfileData {
  const v = (value ?? {}) as Partial<ProfileData>;
  return { common: v.common ?? {}, activities: v.activities ?? {} };
}

function versionView(row: VersionRow): ProfileVersionView {
  return {
    version: row.version,
    activities: row.activities,
    data: readData(row.data),
    source: row.source,
    author: authorLabel(row.author),
    createdAt: row.createdAt.toISOString(),
  };
}

async function latest(prisma: Pick<PrismaClient, 'companyProfileVersion'>, orgId: string) {
  return prisma.companyProfileVersion.findFirst({
    where: { orgId },
    orderBy: { version: 'desc' },
    select: VERSION_SELECT,
  });
}

/** The profile as it is now, what is missing and its latest check. */
export async function getCompanyProfile(
  prisma: PrismaClient,
  orgId: string,
): Promise<CompanyProfileView> {
  const definition = await profileDefinitionFor(prisma, orgId);
  const row = await latest(prisma, orgId);
  const review = row
    ? await prisma.companyProfileReview.findFirst({
        where: { orgId, versionId: row.id },
        orderBy: { createdAt: 'desc' },
        select: {
          outcome: true,
          note: true,
          createdAt: true,
          reviewer: { select: { id: true, email: true } },
        },
      })
    : null;
  const current = row ? versionView(row) : null;
  const missing = missingAnswers(definition, current);
  return {
    definition,
    current,
    missing,
    complete: missing.length === 0,
    review:
      row && review
        ? {
            version: row.version,
            outcome: review.outcome,
            note: review.note,
            reviewer: authorLabel(review.reviewer),
            createdAt: review.createdAt.toISOString(),
          }
        : null,
  };
}

/** Every version, newest first, each with its checks. */
export async function listProfileVersions(
  prisma: PrismaClient,
  orgId: string,
): Promise<Array<ProfileVersionView & { reviews: Omit<ProfileReviewView, 'version'>[] }>> {
  await profileDefinitionFor(prisma, orgId);
  const rows = await prisma.companyProfileVersion.findMany({
    where: { orgId },
    orderBy: { version: 'desc' },
    take: 100,
    select: {
      ...VERSION_SELECT,
      reviews: {
        orderBy: { createdAt: 'asc' },
        select: {
          outcome: true,
          note: true,
          createdAt: true,
          reviewer: { select: { id: true, email: true } },
        },
      },
    },
  });
  return rows.map((r) => ({
    ...versionView(r),
    reviews: r.reviews.map((v) => ({
      outcome: v.outcome,
      note: v.note,
      reviewer: authorLabel(v.reviewer),
      createdAt: v.createdAt.toISOString(),
    })),
  }));
}

/**
 * Saves the profile as a new version. `expectedVersion` (0 for the first) must be the current one:
 * a change made meanwhile is never overwritten. The same content again is refused.
 */
export async function saveCompanyProfile(
  prisma: PrismaClient,
  input: {
    orgId: string;
    userId: string;
    source: ProfileSource;
    grantId?: string;
    activities: unknown;
    data: unknown;
    expectedVersion?: number;
  },
): Promise<CompanyProfileView> {
  const definition = await profileDefinitionFor(prisma, input.orgId);
  const profile = validateProfile(definition, input);
  const current = await latest(prisma, input.orgId);
  const currentVersion = current?.version ?? 0;
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    throw conflict();
  }
  if (
    current &&
    canonical({ a: current.activities, d: readData(current.data) }) ===
      canonical({ a: profile.activities, d: profile.data })
  ) {
    throw new CompanyProfileError('Nessuna modifica da salvare', 400, 'NO_CHANGE');
  }
  try {
    await withTransaction(prisma, async (tx) => {
      const row = await tx.companyProfileVersion.create({
        data: {
          orgId: input.orgId,
          version: currentVersion + 1,
          activities: profile.activities,
          data: profile.data as unknown as Prisma.InputJsonObject,
          source: input.source,
          grantId: input.source === 'DELEGATE' ? (input.grantId ?? null) : null,
          createdBy: input.userId,
        },
        select: { version: true },
      });
      await new AuditService(tx).logEvent({
        tenantId: input.orgId,
        userId: input.userId,
        eventType: 'COMPANY_PROFILE_UPDATED',
        payload: {
          version: row.version,
          source: input.source,
          activities: profile.activities.join(','),
        },
      });
    });
  } catch (err: unknown) {
    // Two saves of the same version at once: the second one lost.
    if ((err as { code?: string } | null)?.code === 'P2002') throw conflict();
    throw err;
  }
  return getCompanyProfile(prisma, input.orgId);
}

function conflict(): CompanyProfileError {
  return new CompanyProfileError(
    'Il profilo è stato modificato nel frattempo: ricarica la pagina e riprova',
    409,
    'VERSION_CONFLICT',
  );
}

/**
 * A check of the current version by a delegate: «verificato», or «servono informazioni» with a
 * note saying what. Never by the company itself (the routes give it only through a delegation).
 */
export async function reviewCompanyProfile(
  prisma: PrismaClient,
  input: {
    orgId: string;
    userId: string;
    grantId: string;
    outcome: ProfileReviewOutcome;
    note?: string | null;
    expectedVersion?: number;
  },
): Promise<CompanyProfileView> {
  await profileDefinitionFor(prisma, input.orgId);
  const current = await latest(prisma, input.orgId);
  if (!current) {
    throw new CompanyProfileError('Il profilo non è ancora stato compilato', 409, 'NO_PROFILE');
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    throw conflict();
  }
  const note = input.note?.trim().replace(/\s+/g, ' ') || null;
  if (input.outcome === 'NEEDS_INFO' && (!note || note.length < NOTE_MIN)) {
    throw new CompanyProfileError(
      `Scrivi quali informazioni servono (almeno ${NOTE_MIN} caratteri)`,
      400,
      'NOTE_REQUIRED',
    );
  }
  if (note && note.length > NOTE_MAX) {
    throw new CompanyProfileError(`La nota può avere al massimo ${NOTE_MAX} caratteri`);
  }
  await withTransaction(prisma, async (tx) => {
    await tx.companyProfileReview.create({
      data: {
        orgId: input.orgId,
        versionId: current.id,
        outcome: input.outcome,
        note,
        grantId: input.grantId,
        reviewedBy: input.userId,
      },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.orgId,
      userId: input.userId,
      eventType: 'COMPANY_PROFILE_REVIEWED',
      payload: { version: current.version, outcome: input.outcome },
    });
  });
  return getCompanyProfile(prisma, input.orgId);
}

/**
 * What the platform console sees of a profile: only the activities declared, by label, never the
 * details. Null when the organization has no profile.
 */
export async function profileActivitiesOf(
  prisma: PrismaClient,
  org: { id: string; module: string; type: OrganizationType },
): Promise<Array<{ id: string; label: string }> | null> {
  const definition = profileDefinitionOf(org.module);
  if (!definition || !PROFILE_TYPES.includes(org.type)) return null;
  const row = await prisma.companyProfileVersion.findFirst({
    where: { orgId: org.id },
    orderBy: { version: 'desc' },
    select: { activities: true },
  });
  return (row?.activities ?? []).map((id) => ({
    id,
    label: definition.activities.find((a) => a.id === id)?.label ?? id,
  }));
}
