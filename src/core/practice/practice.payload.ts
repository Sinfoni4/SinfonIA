import { z } from 'zod';

import { PRACTICE_KINDS, practiceTypeOf, type PracticeKind } from '../../modules/registry.js';

/**
 * The payload of a practice: name, type and the fields its module declares (A02/A04).
 * The kinds and their labels come from the modules (src/modules); the Core only knows the shape.
 */

export { PRACTICE_KINDS, type PracticeKind };

export const PRACTICE_PAYLOAD_TYPES = [
  'artist_practice',
  'music_practice',
  'generic_practice',
  'agri_practice',
  'legacy_practice',
] as const;
export type PracticePayloadType = (typeof PRACTICE_PAYLOAD_TYPES)[number];

export const CURRENT_PAYLOAD_SCHEMA_VERSION = 1;

export const PracticeKindSchema = z.enum(PRACTICE_KINDS);
export const PracticePayloadSchema = z
  .object({
    schemaVersion: z.number().int().min(1).default(CURRENT_PAYLOAD_SCHEMA_VERSION),
    type: z.enum(PRACTICE_PAYLOAD_TYPES),
    name: z.string().trim().min(1),
  })
  .passthrough();

export type PracticePayload = z.infer<typeof PracticePayloadSchema>;
export type PracticePayloadKind = PracticeKind | 'legacy' | 'unknown';

function payloadTypeOf(kind: PracticeKind): PracticePayloadType {
  return `${kind}_practice`;
}

function kindOfPayloadType(type: string): PracticePayloadKind {
  if (type === 'legacy_practice') return 'legacy';
  const kind = type.endsWith('_practice') ? type.slice(0, -'_practice'.length) : '';
  return (PRACTICE_KINDS as readonly string[]).includes(kind) ? (kind as PracticeKind) : 'unknown';
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function payloadTypeLabel(kind: PracticePayloadKind): string {
  if (kind === 'legacy') return 'legacy practice';
  if (kind === 'unknown') return 'practice';
  return practiceTypeOf(kind)?.typeLabel ?? 'practice';
}

export function buildPracticePayload(
  kind: PracticeKind,
  name: string,
  extra?: Record<string, unknown>,
): PracticePayload {
  // The extra data never overrides the type, the name or the schema version.
  return PracticePayloadSchema.parse({
    ...(extra ?? {}),
    schemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
    type: payloadTypeOf(kind),
    name: name.trim(),
  });
}

export function readPracticePayload(payload: unknown): {
  schemaVersion: number;
  name: string | null;
  kind: PracticePayloadKind;
  typeLabel: string;
  summary: string;
  /** A04: the fields of the module, as stored. */
  fields: Record<string, unknown>;
  /** A05: the sub-state set inside the common state, if any. */
  subState: string | null;
} {
  const record = asRecord(payload);
  if (!record) {
    return {
      schemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
      name: null,
      kind: 'unknown',
      typeLabel: 'practice',
      summary: 'practice',
      fields: {},
      subState: null,
    };
  }

  const schemaVersion =
    typeof record.schemaVersion === 'number' && Number.isInteger(record.schemaVersion)
      ? record.schemaVersion
      : 1;

  // `artistName`: practices created before the modules (legacy payloads).
  const rawName = record.name ?? record.artistName;
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
  const rawType = typeof record.type === 'string' ? record.type : null;
  const kind = rawType ? kindOfPayloadType(rawType) : 'legacy';
  const typeLabel = payloadTypeLabel(kind);
  const fields = asRecord(record.fields) ?? {};
  const subState = typeof record.subState === 'string' ? record.subState : null;

  if (!name) {
    return { schemaVersion, name, kind, typeLabel, summary: typeLabel, fields, subState };
  }
  const prefix =
    kind === 'legacy' || kind === 'unknown'
      ? 'pratica'
      : (practiceTypeOf(kind)?.summaryPrefix ?? 'pratica');
  return { schemaVersion, name, kind, typeLabel, summary: `${prefix} ${name}`, fields, subState };
}
