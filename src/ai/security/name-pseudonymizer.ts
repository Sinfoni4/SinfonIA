import type { InterpreterContext } from '../interpreter/interpreter.types.js';

/**
 * Pseudonymization of personal names before LLM egress.
 *
 * Names of people (in the user's message and in the practice names sent as context) are replaced
 * with stable placeholders ([NOME_1], [NOME_2], ...). The same name gets the same placeholder in
 * the message and in the context, so the model can still match "valida la pratica di Mario Rossi"
 * to the right practice without ever seeing the name; the placeholders in its answer are then
 * restored locally.
 */

export interface PseudonymizeResult {
  text: string;
  context?: InterpreterContext;
  /** Placeholder -> original name, for restoring the model's answer. */
  map: Map<string, string>;
}

// Words that start a capitalized sequence or follow "pratica" but are not names.
const NOT_NAMES = new Set([
  'crea',
  'creare',
  'nuova',
  'nuovo',
  'valida',
  'validare',
  'completa',
  'completare',
  'elimina',
  'eliminare',
  'cancella',
  'stato',
  'pratica',
  'pratiche',
  'la',
  'il',
  'lo',
  'le',
  'i',
  'gli',
  'per',
  'di',
  'del',
  'della',
  'dello',
  'dei',
  'degli',
  'delle',
  'con',
  'su',
  'mia',
  'mio',
  'sua',
  'suo',
  'questa',
  'quella',
  'ultima',
  'prima',
  'tutte',
  'tutti',
  'export',
  'lista',
  'scadenza',
  'scadenze',
  'fattura',
  'ddt',
  'durc',
  'album',
  'brano',
  'singolo',
  'ep',
  'ok',
  'grazie',
  'ciao',
  'buongiorno',
  'buonasera',
]);

const WORD = String.raw`[\p{L}][\p{L}'’]*`;
// Two or more capitalized words: "Mario Rossi", "Anna Maria De Luca". Trailing numbers stay part
// of the name ("Spesa Collio 2026"), so a single placeholder covers it.
const CAPITALIZED_SEQUENCE = new RegExp(
  String.raw`\p{Lu}[\p{L}'’]+(?:\s+(?:(?:de|di|del|della|da|van|von|la|lo)\s+)?\p{Lu}[\p{L}'’]+)+(?:\s+\d[\d/.-]*)*`,
  'gu',
);
// Up to three words after "pratica per/di/del/della/dell'/a", also lowercase as typed in chat.
// The preposition is required: in "pratica nuova intestata a ..." the words "intestata a" are not
// a name (found by the real-model evaluation).
const AFTER_PRACTICE = new RegExp(
  String.raw`\bpratic[ah]\s+(?:per|di|del|della|dell'|dello|a)\s+(${WORD}(?:\s+${WORD}){0,2})`,
  'giu',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimNotNames(candidate: string): string | null {
  const words = candidate.trim().split(/\s+/);
  while (words.length && NOT_NAMES.has(words[0].toLowerCase())) words.shift();
  while (words.length && NOT_NAMES.has(words[words.length - 1].toLowerCase())) words.pop();
  // Stop at the first non-name word inside ("mario rossi con album" -> "mario rossi").
  const cut = words.findIndex((w) => NOT_NAMES.has(w.toLowerCase()));
  const kept = cut >= 0 ? words.slice(0, cut) : words;
  const name = kept.join(' ');
  return name.replace(/[\s'’]/g, '').length >= 3 ? name : null;
}

/** Candidate names: known practice names, capitalized sequences, words after "pratica". */
function collectNames(text: string, context?: InterpreterContext): string[] {
  const names: string[] = [];
  for (const practice of context?.practices ?? []) {
    if (practice.name && practice.name.trim().length >= 3) names.push(practice.name.trim());
  }
  for (const match of text.matchAll(CAPITALIZED_SEQUENCE)) {
    const name = trimNotNames(match[0]);
    if (name) names.push(name);
  }
  for (const match of text.matchAll(AFTER_PRACTICE)) {
    const name = trimNotNames(match[1] ?? '');
    if (name) names.push(name);
  }
  return names;
}

export function pseudonymizeNames(text: string, context?: InterpreterContext): PseudonymizeResult {
  // Longest first, so "Mario Rossi Bianchi" is replaced before "Mario Rossi".
  const unique = new Map<string, string>();
  for (const name of collectNames(text, context)) {
    const key = name.toLowerCase();
    if (!unique.has(key)) unique.set(key, name);
  }
  const ordered = [...unique.values()].sort((a, b) => b.length - a.length);

  const map = new Map<string, string>();
  const replacements: Array<{ pattern: RegExp; placeholder: string }> = [];
  ordered.forEach((name, index) => {
    const placeholder = `[NOME_${index + 1}]`;
    map.set(placeholder, name);
    replacements.push({
      // Whole words only, case-insensitive, flexible spacing.
      pattern: new RegExp(
        String.raw`(?<![\p{L}\p{N}])${name
          .split(/\s+/)
          .map(escapeRegExp)
          .join(String.raw`\s+`)}(?![\p{L}\p{N}])`,
        'giu',
      ),
      placeholder,
    });
  });

  const apply = (value: string) =>
    replacements.reduce((acc, r) => acc.replace(r.pattern, r.placeholder), value);

  return {
    text: apply(text),
    map,
    ...(context
      ? {
          context: {
            ...context,
            practices: context.practices?.map((p) => ({
              ...p,
              name: p.name ? apply(p.name) : p.name,
              summary: apply(p.summary),
            })),
          },
        }
      : {}),
  };
}
