/** Telegram Mini App: the summary of the «Oggi» and «Agenda» screens (GET /miniapp/summary). */

import { CATEGORY_LABELS, type DeadlineCategory } from './compliance';
import { STATE_LABELS, type PracticeState } from './practices';

export type MiniAppSummary = {
  documents: { confirmed: number; expected: number; percent: number | null };
  practices: Array<{
    id: string;
    name: string;
    status: PracticeState;
    documents: { confirmed: number; expected: number };
    openRequests: number;
  }>;
  requests: Array<{
    id: string;
    practiceId: string;
    practiceName: string;
    label: string | null;
    message: string;
    dueDate: string | null;
  }>;
  toConfirm: Array<{
    attachmentId: string;
    practiceId: string;
    practiceName: string;
    fileName: string;
  }>;
  deadlines: Array<{
    id: string;
    title: string;
    category: string;
    dueDate: string;
    daysLeft: number;
  }>;
  feed: Array<{
    type: string;
    practiceId: string;
    practiceName: string;
    at: string;
    to?: string;
    expectedLabel?: string;
  }>;
};

const WEEKDAYS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const LETTERS = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const MONTHS = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

/** `YYYY-MM-DD` of a local date. */
export function isoDay(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

export function weekdayName(date: Date): string {
  return WEEKDAYS[date.getDay()];
}

export function monthName(date: Date): string {
  return MONTHS[date.getMonth()];
}

/** Monday to Sunday of the week of `today`, with the deadlines falling on each day. */
export function weekOf(
  today: Date,
  deadlines: MiniAppSummary['deadlines'],
): Array<{ iso: string; letter: string; day: number; today: boolean; hasDeadline: boolean }> {
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const due = new Set(deadlines.map((d) => d.dueDate));
  return LETTERS.map((letter, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const iso = isoDay(day);
    return {
      iso,
      letter,
      day: day.getDate(),
      today: iso === isoDay(today),
      hasDeadline: due.has(iso),
    };
  });
}

/** The greeting by the hour. */
export function greeting(hour: number): string {
  if (hour < 13) return 'Buongiorno';
  if (hour < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `15/11` from `2026-11-15`. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export function deadlineWhen(daysLeft: number): string {
  if (daysLeft < 0) return daysLeft === -1 ? 'scaduta ieri' : `scaduta da ${-daysLeft} giorni`;
  if (daysLeft === 0) return 'oggi';
  if (daysLeft === 1) return 'domani';
  return `tra ${daysLeft} giorni`;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as DeadlineCategory] ?? category;
}

/** One line of the feed: what happened, never who or which data. */
export function describeFeed(item: MiniAppSummary['feed'][number]): {
  title: string;
  text: string;
} {
  const doc = item.expectedLabel ? `«${item.expectedLabel}»` : 'un documento';
  switch (item.type) {
    case 'ATTACHMENT_ADDED':
      return { title: 'Documento ricevuto', text: `per ${item.practiceName}` };
    case 'ATTACHMENT_VALIDATED':
      return { title: 'Documento confermato', text: `in ${item.practiceName}` };
    case 'ATTACHMENT_REJECTED':
      return {
        title: 'Documento non accettato',
        text: `in ${item.practiceName}: mandane uno nuovo`,
      };
    case 'ATTACHMENT_READ_RETRIED':
      return { title: 'Documento letto', text: `al nuovo tentativo, in ${item.practiceName}` };
    case 'ATTACHMENT_READ_FAILED':
      return {
        title: 'Documento non leggibile',
        text: `in ${item.practiceName}: lo controlla un operatore`,
      };
    case 'DOCUMENT_REQUESTED':
      return { title: `Richiesto ${doc}`, text: `per ${item.practiceName}` };
    case 'DOCUMENT_REQUEST_FULFILLED':
      return { title: 'Richiesta soddisfatta', text: `per ${item.practiceName}` };
    case 'PRACTICE_CREATED':
      return { title: 'Pratica aperta', text: item.practiceName };
    case 'PRACTICE_STATE_CHANGED':
      return {
        title: item.practiceName,
        text: item.to
          ? `ora è «${STATE_LABELS[item.to as PracticeState] ?? item.to}»`
          : 'aggiornata',
      };
    default:
      return { title: item.practiceName, text: 'aggiornata' };
  }
}

/** The tint of a feed item: requests amber, problems red, the rest green. */
export function feedTone(type: string): 'ok' | 'ask' | 'bad' {
  if (type === 'DOCUMENT_REQUESTED') return 'ask';
  if (type === 'ATTACHMENT_REJECTED' || type === 'ATTACHMENT_READ_FAILED') return 'bad';
  return 'ok';
}
