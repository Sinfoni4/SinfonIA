import { parseItalianDate, toIsoDate } from './compliance.dates.js';

import type { ComplianceCategory } from '@prisma/client';

export type ComplianceCommand =
  | { type: 'LIST_DEADLINES' }
  | {
      type: 'CREATE_DEADLINE';
      payload: { category: ComplianceCategory; dueDate: string; title: string };
    }
  | { type: 'CLOSE_DEADLINE'; payload: { code: string } }
  /** Recognized command with unusable arguments: `reason` tells the user what is wrong. */
  | { type: 'INVALID_COMPLIANCE_COMMAND'; reason: string };

// Words a member would actually type for each category.
const CATEGORY_ALIASES: Record<string, ComplianceCategory> = {
  durc: 'DURC',
  sicurezza: 'SICUREZZA_LAVORO',
  sicurezza_lavoro: 'SICUREZZA_LAVORO',
  formazione: 'SICUREZZA_LAVORO',
  bio: 'CERTIFICAZIONE_BIO',
  biologico: 'CERTIFICAZIONE_BIO',
  certificazione_bio: 'CERTIFICAZIONE_BIO',
  visita: 'VISITA_MEDICA',
  visita_medica: 'VISITA_MEDICA',
  patentino: 'PATENTINO',
  altro: 'ALTRO',
};

export const CREATE_DEADLINE_USAGE =
  'Scrivi: nuova scadenza <tipo> <gg/mm/aaaa> <descrizione>\n' +
  'Tipi: durc, sicurezza, bio, visita, patentino, altro\n' +
  'Esempio: nuova scadenza durc 31/12/2026 DURC cooperativa';

/**
 * Deterministic Telegram commands for compliance deadlines:
 * "scadenze", "nuova scadenza durc 31/12/2026 DURC cooperativa", "chiudi scadenza ab12cd34".
 */
export function parseComplianceCommand(input: string): ComplianceCommand | null {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'scadenze' || lower === 'lista scadenze') {
    return { type: 'LIST_DEADLINES' };
  }

  if (lower === 'nuova scadenza' || lower.startsWith('nuova scadenza ')) {
    const [categoryWord, dateWord, ...titleWords] = trimmed
      .slice('nuova scadenza'.length)
      .trim()
      .split(/\s+/);
    const category = categoryWord ? CATEGORY_ALIASES[categoryWord.toLowerCase()] : undefined;
    if (!category) {
      return {
        type: 'INVALID_COMPLIANCE_COMMAND',
        reason: `Tipo non riconosciuto.\n${CREATE_DEADLINE_USAGE}`,
      };
    }
    const dueDate = dateWord ? parseItalianDate(dateWord) : null;
    if (!dueDate) {
      return {
        type: 'INVALID_COMPLIANCE_COMMAND',
        reason: `Data non valida.\n${CREATE_DEADLINE_USAGE}`,
      };
    }
    const title = titleWords.join(' ').trim();
    if (!title) {
      return {
        type: 'INVALID_COMPLIANCE_COMMAND',
        reason: `Manca la descrizione.\n${CREATE_DEADLINE_USAGE}`,
      };
    }
    return { type: 'CREATE_DEADLINE', payload: { category, dueDate: toIsoDate(dueDate), title } };
  }

  if (lower === 'chiudi scadenza' || lower.startsWith('chiudi scadenza ')) {
    const code = trimmed.slice('chiudi scadenza'.length).trim().toLowerCase();
    if (!/^[0-9a-f]{6,}$/.test(code) && !/^[0-9a-f-]{36}$/.test(code)) {
      return {
        type: 'INVALID_COMPLIANCE_COMMAND',
        reason:
          'Indica il codice della scadenza, ad esempio: chiudi scadenza ab12cd34 (lo trovi con "scadenze").',
      };
    }
    return { type: 'CLOSE_DEADLINE', payload: { code } };
  }

  return null;
}
