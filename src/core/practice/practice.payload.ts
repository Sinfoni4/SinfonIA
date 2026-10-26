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

export const PracticeKindSchema = z.enum(PRACTICE_KINDS);
export const PracticePayloadSchema = z
  .object({
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

export function buildPracticePayload(kind: PracticeKind, name: string): PracticePayload {
  return PracticePayloadSchema.parse({
    type: PAYLOAD_TYPE_BY_KIND[kind],
    name: name.trim(),
  });
}

export function readPracticePayload(payload: unknown): {
  name: string | null;
  kind: PracticePayloadKind;
  typeLabel: string;
  summary: string;
} {
  const record = asRecord(payload);
  if (!record) {
    return {
      name: null,
      kind: 'unknown',
      typeLabel: 'practice',
      summary: 'practice',
    };
  }

  const rawName = record.name ?? record.artistName;
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null;
  const rawType = typeof record.type === 'string' ? record.type : null;
  const kind = rawType ? (KIND_BY_PAYLOAD_TYPE[rawType] ?? 'unknown') : 'legacy';
  const typeLabel = payloadTypeLabel(kind);

  if (!name) {
    return { name, kind, typeLabel, summary: typeLabel };
  }

  switch (kind) {
    case 'artist':
      return { name, kind, typeLabel, summary: `pratica artista ${name}` };
    case 'music':
      return { name, kind, typeLabel, summary: `pratica music ${name}` };
    default:
      return { name, kind, typeLabel, summary: `pratica ${name}` };
  }
}
