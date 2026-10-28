/**
 * Calendar helpers for compliance deadlines. Due dates are calendar days (no time), and "today"
 * is the date in Italy, so a reminder never shifts by one day around midnight UTC.
 */

export const COMPLIANCE_TIME_ZONE = 'Europe/Rome';

/** Reminder thresholds in days before the due date; 0 = due today or already overdue. */
export const REMINDER_THRESHOLDS = [30, 15, 7, 1, 0] as const;

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ITALIAN_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

const romeDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: COMPLIANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in Italy as YYYY-MM-DD. */
export function todayInRome(now = new Date()): string {
  return romeDateFormat.format(now);
}

/** Parses YYYY-MM-DD into a UTC-midnight Date, rejecting impossible dates (e.g. 2026-02-30). */
export function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Parses an Italian date (gg/mm/aaaa, also with "." or "-") into a UTC-midnight Date. */
export function parseItalianDate(value: string): Date | null {
  const match = ITALIAN_DATE.exec(value.trim());
  if (!match) return null;
  return buildDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

function buildDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatItalianDate(date: Date): string {
  const [year, month, day] = toIsoDate(date).split('-');
  return `${day}/${month}/${year}`;
}

/** Whole days from `today` (YYYY-MM-DD) to `dueDate`; negative when overdue. */
export function daysUntil(dueDate: Date, today: string): number {
  return Math.round((dueDate.getTime() - parseIsoDate(today)!.getTime()) / DAY_MS);
}

/**
 * The reminder due for a deadline `daysLeft` away: the tightest threshold not yet passed.
 * A deadline created 5 days before its due date gets only the 7-day reminder, not the 30 and
 * 15 ones as a burst. Returns null when the deadline is still more than 30 days away.
 */
export function reminderThresholdFor(daysLeft: number): number | null {
  if (daysLeft <= 0) return 0;
  const candidates = REMINDER_THRESHOLDS.filter((t) => t > 0 && daysLeft <= t);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
