import { z } from 'zod';

import type { PracticeView } from '../../core/practice/practice.application.service.js';

/**
 * Chooses the practice a chat file is attached to. AGX-01: a file is never attached without the
 * person saying where: when one practice is likely (the only open one, or the one named in the
 * caption) it is proposed first and confirmed with «sì», otherwise the person picks one.
 */

export type AttachmentCandidate = Pick<PracticeView, 'id' | 'name' | 'status'>;

export type TelegramFileRef = {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  hint?: string;
  /** Sent as a Telegram photo, which Telegram compresses (1280 px): OCR works better on files. */
  compressedPhoto?: boolean;
};

export type AttachmentTarget =
  | { type: 'none' }
  /** `suggested`: the first candidate is the likely one, confirmed with «sì». */
  | { type: 'ask'; candidates: AttachmentCandidate[]; suggested: boolean };

const MAX_CANDIDATES = 5;
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED']);

/**
 * @param practices the user's practices, most recent first
 * @param caption text sent with the file; a practice named in it is proposed first
 */
export function resolveAttachmentTarget(
  practices: AttachmentCandidate[],
  caption: string,
): AttachmentTarget {
  const open = practices.filter((p) => !TERMINAL_STATES.has(p.status));
  // Closed practices are offered only when nothing is open, and never proposed as the likely one.
  const pool = open.length > 0 ? open : practices;
  if (pool.length === 0) return { type: 'none' };

  let likely: AttachmentCandidate | undefined;
  const normalizedCaption = normalize(caption);
  if (normalizedCaption) {
    // Whole-word match: "Rossi" must not match a caption mentioning "Rossini".
    const paddedCaption = ` ${normalizedCaption} `;
    const named = pool.filter((p) => {
      const name = normalize(p.name);
      return name.length >= 3 && paddedCaption.includes(` ${name} `);
    });
    if (named.length === 1) likely = named[0];
  }
  if (!likely && open.length === 1) likely = open[0];

  const candidates = likely
    ? [likely, ...pool.filter((p) => p.id !== likely.id)].slice(0, MAX_CANDIDATES)
    : pool.slice(0, MAX_CANDIDATES);
  return { type: 'ask', candidates, suggested: Boolean(likely) };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Reads the user's answer: a 1-based choice, a cancellation, or null when it is not an answer.
 * With a suggested practice, «sì» chooses it (it is always the first).
 */
export function parseAttachmentSelection(
  text: string,
  candidateCount: number,
  suggested = false,
): number | 'cancel' | null {
  const trimmed = text.trim().toLowerCase();
  if (/^(?:annulla|no|stop)$/.test(trimmed)) return 'cancel';
  if (suggested && /^(?:s[iì]|conferm[ao])[.!]?$/.test(trimmed)) return 1;
  const match = trimmed.match(/^(\d{1,2})[).]?$/);
  if (!match?.[1]) return null;
  const choice = Number(match[1]);
  return choice >= 1 && choice <= candidateCount ? choice : null;
}

export function formatAttachmentQuestion(
  candidates: AttachmentCandidate[],
  suggested = false,
): string {
  const lines = candidates.map((c, i) => `${i + 1}) ${c.name} (${c.status})`);
  const [first] = candidates;
  if (suggested && first) {
    if (candidates.length === 1) {
      return [
        `📄 Ho ricevuto il file. Lo associo alla pratica «${first.name}»?`,
        'Rispondi «sì», oppure "annulla".',
      ].join('\n');
    }
    return [
      `📄 Ho ricevuto il file. Lo associo alla pratica «${first.name}»?`,
      "Rispondi «sì», oppure scegli un'altra pratica con il numero:",
      ...lines,
      'Per non associarlo rispondi "annulla".',
    ].join('\n');
  }
  return [
    '📄 Ho ricevuto il file. A quale pratica lo associo?',
    ...lines,
    'Rispondi con il numero, oppure "annulla".',
  ].join('\n');
}

/** How long a received file waits for the person's answer. */
export const PENDING_FILE_TTL_MS = 10 * 60_000;

const CandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['CREATED', 'VALIDATED', 'SUBMITTED', 'COMPLETED', 'FAILED']),
});

/**
 * AGX-01: a file received in chat that still waits for an answer, kept in the conversation
 * memory (the database in production) so a restart does not lose it. Only what is needed to
 * download it again from the channel (`ref`) is kept, never its content.
 */
const PendingFileSchema = z.object({
  channel: z.string(),
  tenantId: z.string(),
  file: z.object({
    ref: z.string().optional(),
    fileName: z.string(),
    mimeType: z.string(),
    fileSize: z.number().optional(),
    hint: z.string().optional(),
    compressedPhoto: z.boolean().optional(),
  }),
  /** `choose`: the person picks the practice; `duplicate`: the file was already sent. */
  stage: z.enum(['choose', 'duplicate']),
  candidates: z.array(CandidateSchema),
  suggested: z.boolean(),
  /** `duplicate`: the practice chosen, waiting for «sì» to send the file again. */
  practice: CandidateSchema.optional(),
  expiresAt: z.number(),
});

export type PendingFile = z.infer<typeof PendingFileSchema>;

/** A stored pending file, or null when missing or no longer valid. */
export function readPendingFile(value: unknown): PendingFile | null {
  const parsed = PendingFileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
