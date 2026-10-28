import type { PracticeView } from '../../core/practice/practice.application.service.js';

/**
 * Chooses the practice a Telegram file is attached to. A file is never attached to a
 * practice by guesswork: with more than one candidate the user is asked to pick one.
 */

export type AttachmentCandidate = Pick<PracticeView, 'id' | 'name' | 'status'>;

export type TelegramFileRef = {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  hint?: string;
};

export type AttachmentTarget =
  | { type: 'none' }
  | { type: 'selected'; practice: AttachmentCandidate }
  | { type: 'ask'; candidates: AttachmentCandidate[] };

const MAX_CANDIDATES = 5;
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED']);

/**
 * @param practices the user's practices, most recent first
 * @param caption text sent with the file; a practice named in it is selected directly
 */
export function resolveAttachmentTarget(
  practices: AttachmentCandidate[],
  caption: string,
): AttachmentTarget {
  const open = practices.filter((p) => !TERMINAL_STATES.has(p.status));
  // Closed practices are offered only when nothing is open, and never chosen without asking.
  const pool = open.length > 0 ? open : practices;
  if (pool.length === 0) return { type: 'none' };
  if (open.length === 1 && open[0]) return { type: 'selected', practice: open[0] };

  const normalizedCaption = normalize(caption);
  if (normalizedCaption) {
    // Whole-word match: "Rossi" must not match a caption mentioning "Rossini".
    const paddedCaption = ` ${normalizedCaption} `;
    const named = pool.filter((p) => {
      const name = normalize(p.name);
      return name.length >= 3 && paddedCaption.includes(` ${name} `);
    });
    if (named.length === 1 && named[0]) return { type: 'selected', practice: named[0] };
  }

  return { type: 'ask', candidates: pool.slice(0, MAX_CANDIDATES) };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Reads the user's answer: a 1-based choice, a cancellation, or null when it is not an answer. */
export function parseAttachmentSelection(
  text: string,
  candidateCount: number,
): number | 'cancel' | null {
  const trimmed = text.trim().toLowerCase();
  if (/^(?:annulla|no|stop)$/.test(trimmed)) return 'cancel';
  const match = trimmed.match(/^(\d{1,2})[).]?$/);
  if (!match?.[1]) return null;
  const choice = Number(match[1]);
  return choice >= 1 && choice <= candidateCount ? choice : null;
}

export function formatAttachmentQuestion(candidates: AttachmentCandidate[]): string {
  const lines = candidates.map((c, i) => `${i + 1}) ${c.name} (${c.status})`);
  return [
    '📄 Ho ricevuto il file. A quale pratica lo associo?',
    ...lines,
    'Rispondi con il numero, oppure "annulla".',
  ].join('\n');
}

type PendingAttachment = {
  file: TelegramFileRef;
  candidates: AttachmentCandidate[];
  expiresAt: number;
};

/** Files waiting for the user to choose a practice, kept in memory for a short time. */
export class PendingAttachmentStore {
  private readonly pending = new Map<string, PendingAttachment>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  set(userId: string, file: TelegramFileRef, candidates: AttachmentCandidate[]): void {
    this.pending.set(userId, { file, candidates, expiresAt: this.now() + this.ttlMs });
  }

  get(userId: string): Omit<PendingAttachment, 'expiresAt'> | null {
    const entry = this.pending.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(userId);
      return null;
    }
    return { file: entry.file, candidates: entry.candidates };
  }

  delete(userId: string): void {
    this.pending.delete(userId);
  }
}
