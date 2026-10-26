import { z } from 'zod';

export const PRACTICE_KINDS = ['artist', 'music', 'generic'] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

export const PRACTICE_PAYLOAD_TYPES = [
  'artist_practice',
  'music_practice',
  'generic_practice',
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

const PAYLOAD_TYPE_BY_KIND: Readonly<Record<PracticeKind, PracticePayloadType>> = {
  artist: 'artist_practice',
  music: 'music_practice',
  generic: 'generic_practice',
};

const KIND_BY_PAYLOAD_TYPE: Readonly<Record<string, PracticePayloadKind>> = {
  artist_practice: 'artist',
  music_practice: 'music',
  generic_practice: 'generic',
  legacy_practice: 'legacy',
};

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function payloadTypeLabel(kind: PracticePayloadKind): string {
  switch (kind) {
    case 'artist':
      return 'artist practice';
    case 'music':
      return 'music practice';
    case 'generic':
      return 'generic practice';
    case 'legacy':
      return 'legacy practice';
    default:
      return 'practice';
  }
}

export function buildPracticePayload(
  kind: PracticeKind,
  name: string,
  extra?: Record<string, unknown>,
): PracticePayload {
  return PracticePayloadSchema.parse({
    schemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
    type: PAYLOAD_TYPE_BY_KIND[kind],
    name: name.trim(),
    ...(extra ?? {}),
  });
}

export function readPracticePayload(payload: unknown): {
  schemaVersion: number;
  name: string | null;
  kind: PracticePayloadKind;
  typeLabel: string;
  summary: string;
} {
  const record = asRecord(payload);
  if (!record) {
    return {
      schemaVersion: CURRENT_PAYLOAD_SCHEMA_VERSION,
      name: null,
      kind: 'unknown',
      typeLabel: 'practice',
      summary: 'practice',
    };
  }

  const schemaVersion =
    typeof record.schemaVersion === 'number' && Number.isInteger(record.schemaVersion)
      ? record.schemaVersion
      : 1;

  const rawName = record.name ?? record.artistName;
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
  const rawType = typeof record.type === 'string' ? record.type : null;
  const kind = rawType ? (KIND_BY_PAYLOAD_TYPE[rawType] ?? 'unknown') : 'legacy';
  const typeLabel = payloadTypeLabel(kind);

  if (!name) {
    return { schemaVersion, name, kind, typeLabel, summary: typeLabel };
  }

  switch (kind) {
    case 'artist':
      return { schemaVersion, name, kind, typeLabel, summary: `pratica artista ${name}` };
    case 'music':
      return { schemaVersion, name, kind, typeLabel, summary: `pratica music ${name}` };
    default:
      return { schemaVersion, name, kind, typeLabel, summary: `pratica ${name}` };
  }
}
