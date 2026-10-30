/**
 * Small typing errors in chat commands («Scadenzi», «lsta pratiche»): the closest command is
 * found by edit distance on its fixed words, never on the free part (names, dates). The caller
 * runs a read-only command at once when the error is a single character, and asks for
 * confirmation otherwise; a command that changes data is never run without «sì».
 */

type CommandSpec = {
  /** Fixed words of the command, lower case. */
  phrase: string;
  /** Reads only: safe to run when the correction is certain. */
  readOnly: boolean;
};

const COMMANDS: CommandSpec[] = [
  { phrase: 'lista pratiche', readOnly: true },
  { phrase: 'pratiche azienda', readOnly: true },
  { phrase: 'stato pratica azienda', readOnly: true },
  { phrase: 'stato pratica', readOnly: true },
  { phrase: 'export pratiche', readOnly: true },
  { phrase: 'scadenze', readOnly: true },
  { phrase: 'lista scadenze', readOnly: true },
  { phrase: 'crea pratica', readOnly: false },
  { phrase: 'elimina pratica', readOnly: false },
  { phrase: 'valida pratica azienda', readOnly: false },
  { phrase: 'completa pratica azienda', readOnly: false },
  { phrase: 'nuova scadenza', readOnly: false },
  { phrase: 'chiudi scadenza', readOnly: false },
  { phrase: 'attiva export pianificato', readOnly: false },
  { phrase: 'disattiva export pianificato', readOnly: false },
];

export type CommandSuggestion = {
  /** The message with the fixed words corrected, the rest unchanged. */
  corrected: string;
  /** The fixed words of the command, for the reply. */
  phrase: string;
  readOnly: boolean;
  distance: number;
};

function normalize(text: string): string {
  // Accents removed: «attivà» and «attiva» are the same word here.
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The command the message most likely meant, or null: when it is already a command, when nothing
 * is close enough, when two different commands are equally close, or when the corrected message
 * would still not be a valid command (e.g. «stato pratiche» with no name).
 */
export function suggestCommand(
  text: string,
  isCommand: (text: string) => boolean,
): CommandSuggestion | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300 || isCommand(trimmed)) return null;
  const words = trimmed.split(/\s+/);
  let best: CommandSuggestion | null = null;
  let tie = false;
  for (const spec of COMMANDS) {
    const size = spec.phrase.split(' ').length;
    if (words.length < size) continue;
    const head = normalize(words.slice(0, size).join(' '));
    const distance = editDistance(head, spec.phrase);
    // Exactly the command words but not a valid command: a sentence for the AI, not a typo.
    if (distance === 0) return null;
    if (distance > (spec.phrase.length <= 8 ? 1 : 2)) continue;
    const corrected = [spec.phrase, ...words.slice(size)].join(' ');
    if (!isCommand(corrected)) continue;
    if (!best || distance < best.distance) {
      best = { corrected, phrase: spec.phrase, readOnly: spec.readOnly, distance };
      tie = false;
    } else if (distance === best.distance && spec.phrase !== best.phrase) {
      tie = true;
    }
  }
  return tie ? null : best;
}
