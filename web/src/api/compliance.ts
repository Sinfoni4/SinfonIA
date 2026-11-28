/** Compliance deadlines and practice exports, as the API returns them. */

export type DeadlineCategory =
  'DURC' | 'SICUREZZA_LAVORO' | 'CERTIFICAZIONE_BIO' | 'VISITA_MEDICA' | 'PATENTINO' | 'ALTRO';

export type Deadline = {
  id: string;
  shortId: string;
  category: DeadlineCategory;
  title: string;
  dueDate: string;
  daysLeft: number;
  status: 'OPEN' | 'CLOSED';
  /** Fase 1B; missing on older APIs: confirmed. */
  certainty?: DeadlineCertainty;
  verifiedAt?: string | null;
  userId: string | null;
  notes: string | null;
  closedAt: string | null;
  createdAt: string;
};

export const CATEGORY_LABELS: Record<DeadlineCategory, string> = {
  DURC: 'DURC',
  SICUREZZA_LAVORO: 'Formazione sicurezza sul lavoro',
  CERTIFICAZIONE_BIO: 'Certificazione biologica',
  VISITA_MEDICA: 'Visita medica',
  PATENTINO: 'Patentino',
  ALTRO: 'Altro',
};

/**
 * Fase 1B: how sure a deadline is. Confirmed is reminded as usual, to be checked is reminded
 * saying so, for information only is never reminded nor counted.
 */
export type DeadlineCertainty = 'CONFIRMED' | 'TO_VERIFY' | 'INFORMATIONAL';

export const CERTAINTY_LABELS: Record<DeadlineCertainty, string> = {
  CONFIRMED: 'Confermata',
  TO_VERIFY: 'Da verificare',
  INFORMATIONAL: 'Informativa',
};

export const CERTAINTY_HINTS: Record<DeadlineCertainty, string> = {
  CONFIRMED: 'promemoria come sempre',
  TO_VERIFY: 'promemoria con «da verificare», finché qualcuno la conferma',
  INFORMATIONAL: 'nessun promemoria, non conta tra le scadute',
};

export type DeadlineFilters = {
  status: 'OPEN' | 'CLOSED' | '';
  category: DeadlineCategory | '';
  certainty?: DeadlineCertainty | '';
};

export function deadlinesQuery(filters: DeadlineFilters): string {
  const params = new URLSearchParams({ limit: '200' });
  if (filters.status) params.set('status', filters.status);
  if (filters.category) params.set('category', filters.category);
  if (filters.certainty) params.set('certainty', filters.certainty);
  return `/compliance/deadlines?${params.toString()}`;
}

/** «tra 12 giorni», «oggi», «scaduta da 3 giorni». */
export function daysLabel(daysLeft: number): string {
  if (daysLeft === 0) return 'oggi';
  if (daysLeft === 1) return 'domani';
  if (daysLeft > 1) return `tra ${daysLeft} giorni`;
  return daysLeft === -1 ? 'scaduta da 1 giorno' : `scaduta da ${-daysLeft} giorni`;
}

/** An ISO date (YYYY-MM-DD) as dd/mm/yyyy. */
export function isoToItalian(date: string): string {
  return date.slice(0, 10).split('-').reverse().join('/');
}

export type ExportFilter =
  { type: 'all' } | { type: 'today' } | { type: 'month' } | { type: 'year'; value: number };

export type ExportResult = { title: string; csv: string; count: number };

/** A safe file name for the exported CSV. */
export function exportFileName(title: string): string {
  const base = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${base || 'export-pratiche'}.csv`;
}
