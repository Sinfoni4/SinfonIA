import { formatItalianDate, parseIsoDate } from './compliance.dates.js';
import { COMPLIANCE_CATEGORY_LABELS } from './compliance.service.js';

import type { ComplianceReminderPayload } from './compliance.service.js';

function whenText(daysLeft: number): string {
  if (daysLeft < 0) {
    const days = -daysLeft;
    return `è scaduta da ${days} ${days === 1 ? 'giorno' : 'giorni'}`;
  }
  if (daysLeft === 0) return 'scade oggi';
  if (daysLeft === 1) return 'scade domani';
  return `scade tra ${daysLeft} giorni`;
}

/** Telegram text of a deadline reminder. */
export function formatReminderMessage(payload: ComplianceReminderPayload): string {
  const icon = payload.daysLeft <= 1 ? '⚠️' : '⏰';
  const dueDate = parseIsoDate(payload.dueDate);
  return [
    `${icon} Scadenza ${COMPLIANCE_CATEGORY_LABELS[payload.category]}: ${whenText(payload.daysLeft)}`,
    `📌 ${payload.title}`,
    `📅 ${dueDate ? formatItalianDate(dueDate) : payload.dueDate}`,
    '',
    `Quando è rinnovata: "chiudi scadenza ${payload.deadlineId.slice(0, 8)}"`,
  ].join('\n');
}
