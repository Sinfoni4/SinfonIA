/** Home numbers, activity log, assistant usage and settings of the organization (FE6). */

import { ROLE_LABELS, type Role } from './client';
import { CATEGORY_LABELS, type DeadlineCategory } from './compliance';
import { STATE_LABELS, type PracticeState } from './practices';

export type Summary = {
  practices: { total: number; byStatus: Record<PracticeState, number> };
  deadlines: {
    overdue: number;
    dueSoon: number;
    upcoming: Array<{
      id: string;
      title: string;
      category: DeadlineCategory;
      dueDate: string;
      daysLeft: number;
    }>;
  };
  documents: {
    toReview: number;
    unreadable: number;
    items: Array<{
      attachmentId: string;
      practiceId: string;
      practiceName: string;
      fileName: string;
      reason: 'review' | 'unreadable';
    }>;
  };
  recentPractices: Array<{ id: string; name: string; status: PracticeState; updatedAt: string }>;
};

/** Practices still in progress: neither completed nor failed. */
export function openPractices(summary: Summary): number {
  const s = summary.practices.byStatus;
  return s.CREATED + s.VALIDATED + s.SUBMITTED;
}

// --- activity log ----------------------------------------------------------------------------

export type AuditPerson = { userId: string; email: string | null };

export type AuditEvent = {
  id: string;
  at: string;
  type: string;
  actor: AuditPerson | null;
  target: AuditPerson | null;
  practice: { id: string; name: string | null } | null;
  period: string | null;
  details: Partial<
    Record<
      | 'role'
      | 'from'
      | 'to'
      | 'permission'
      | 'channel'
      | 'scope'
      | 'rows'
      | 'category'
      | 'dueDate'
      | 'name'
      | 'frequency'
      | 'scheduledExport'
      | 'byPlatform',
      string | number | boolean
    >
  >;
};

export type AuditPage = {
  items: AuditEvent[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/** Groups of events for the filter of the log; each group lists the stored event types. */
export const EVENT_GROUPS: Record<string, { label: string; types: string[] }> = {
  access: { label: 'Accessi', types: ['LOGIN_SUCCEEDED'] },
  people: {
    label: 'Persone e permessi',
    types: [
      'INVITATION_CREATED',
      'INVITATION_ACCEPTED',
      'INVITATION_REVOKED',
      'MEMBER_ROLE_CHANGED',
      'MEMBERSHIP_REVOKED',
      'MEMBERSHIP_REACTIVATED',
      'PERMISSION_GRANTED',
      'PERMISSION_WITHDRAWN',
      'SCHEDULED_EXPORT_ENABLED',
      'SCHEDULED_EXPORT_DISABLED',
    ],
  },
  practices: {
    label: 'Pratiche',
    types: ['PRACTICE_CREATED', 'PRACTICE_STATE_CHANGED', 'PRACTICE_DELETED'],
  },
  deadlines: {
    label: 'Scadenze',
    types: [
      'COMPLIANCE_DEADLINE_CREATED',
      'COMPLIANCE_DEADLINE_CLOSED',
      'COMPLIANCE_DEADLINE_REMINDER',
    ],
  },
  exports: {
    label: 'Export',
    types: ['EXPORT_GENERATED', 'EXPORT_DELIVERED', 'PRACTICE_EXPORT_GENERATED'],
  },
  settings: {
    label: 'Impostazioni e piattaforma',
    types: [
      'ORGANIZATION_SETTINGS_CHANGED',
      'ORGANIZATION_CREATED',
      'ORGANIZATION_SUSPENDED',
      'ORGANIZATION_REACTIVATED',
    ],
  },
};

const CHANNEL_LABELS: Record<string, string> = {
  web: 'dashboard',
  api: 'API',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

const PERIOD_LABELS: Record<string, string> = {
  today: 'di oggi',
  month: 'del mese',
  year: "dell'anno",
  all: 'complete',
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'ogni giorno',
  weekly: 'ogni settimana',
  monthly: 'ogni mese',
};

function who(person: AuditPerson | null): string {
  if (!person) return 'una persona';
  return person.email ?? 'un account della chat';
}

function roleName(value: unknown): string {
  return typeof value === 'string' && value in ROLE_LABELS
    ? ROLE_LABELS[value as Role]
    : String(value);
}

function stateName(value: unknown): string {
  return typeof value === 'string' && value in STATE_LABELS
    ? STATE_LABELS[value as PracticeState].toLowerCase()
    : String(value);
}

/** Who did it: a person by email, a chat account, or SinfonIA by itself (scheduler, reminders). */
export function actorLabel(event: Pick<AuditEvent, 'actor' | 'details'>): string {
  if (event.details.byPlatform === true) return 'gestore della piattaforma';
  if (!event.actor) return 'SinfonIA (automatico)';
  return event.actor.email ?? 'account della chat';
}

/** What happened, in one Italian sentence (without who did it). */
export function describeEvent(event: AuditEvent): string {
  const d = event.details;
  const practice = event.practice
    ? `«${event.practice.name ?? 'pratica eliminata'}»`
    : 'una pratica';
  const target = who(event.target);
  const channel =
    typeof d.channel === 'string' ? ` (${CHANNEL_LABELS[d.channel] ?? d.channel})` : '';
  const rows = typeof d.rows === 'number' ? `, ${d.rows} ${d.rows === 1 ? 'riga' : 'righe'}` : '';
  const period = event.period ? ` ${PERIOD_LABELS[event.period] ?? ''}`.trimEnd() : '';
  const category =
    typeof d.category === 'string'
      ? (CATEGORY_LABELS[d.category as DeadlineCategory] ?? d.category)
      : 'scadenza';
  switch (event.type) {
    case 'LOGIN_SUCCEEDED':
      return 'Accesso con codice via email';
    case 'INVITATION_CREATED':
      return `Invito inviato come ${roleName(d.role)}`;
    case 'INVITATION_ACCEPTED':
      return `Invito accettato come ${roleName(d.role)}`;
    case 'INVITATION_REVOKED':
      return 'Invito revocato';
    case 'MEMBER_ROLE_CHANGED':
      return `Ruolo di ${target}: da ${roleName(d.from)} a ${roleName(d.to)}`;
    case 'MEMBERSHIP_REVOKED':
      return `Accesso revocato a ${target}`;
    case 'MEMBERSHIP_REACTIVATED':
      return `Accesso riattivato a ${target}`;
    case 'PERMISSION_GRANTED':
      return `${target} può esportare tutta l'azienda`;
    case 'PERMISSION_WITHDRAWN':
      return `${target} non esporta più tutta l'azienda`;
    case 'SCHEDULED_EXPORT_ENABLED':
      return `Export pianificato in chat attivato per ${target}`;
    case 'SCHEDULED_EXPORT_DISABLED':
      return `Export pianificato in chat disattivato per ${target}`;
    case 'PRACTICE_CREATED':
      return `Pratica ${practice} creata`;
    case 'PRACTICE_STATE_CHANGED':
      return `Pratica ${practice}: da ${stateName(d.from)} a ${stateName(d.to)}`;
    case 'PRACTICE_DELETED':
      return `Pratica ${practice} eliminata`;
    case 'COMPLIANCE_DEADLINE_CREATED':
      return `Nuova scadenza: ${category}`;
    case 'COMPLIANCE_DEADLINE_CLOSED':
      return 'Scadenza chiusa';
    case 'COMPLIANCE_DEADLINE_REMINDER':
      return `Promemoria inviato: ${category}`;
    case 'EXPORT_GENERATED':
    case 'PRACTICE_EXPORT_GENERATED':
      return `Export pratiche${period}${channel}${rows}`;
    case 'EXPORT_DELIVERED':
      return `Export consegnato a ${target}${channel}${rows}`;
    case 'ORGANIZATION_CREATED':
      return 'Organizzazione creata dal gestore della piattaforma';
    case 'ORGANIZATION_SUSPENDED':
      return 'Organizzazione sospesa dal gestore della piattaforma';
    case 'ORGANIZATION_REACTIVATED':
      return 'Organizzazione riattivata dal gestore della piattaforma';
    case 'ORGANIZATION_SETTINGS_CHANGED': {
      const parts: string[] = [];
      if (typeof d.name === 'string') parts.push(`nome «${d.name}»`);
      if (typeof d.scheduledExport === 'boolean')
        parts.push(`export pianificato ${d.scheduledExport ? 'attivato' : 'disattivato'}`);
      if (typeof d.frequency === 'string' && d.frequency in FREQUENCY_LABELS)
        parts.push(`frequenza ${FREQUENCY_LABELS[d.frequency as Frequency]}`);
      return `Impostazioni: ${parts.join(', ') || 'modificate'}`;
    }
    default:
      return event.type.toLowerCase().replace(/_/g, ' ');
  }
}

export function auditQuery(filters: {
  page: number;
  group: string;
  from: string;
  to: string;
  limit?: number;
}): string {
  const params = new URLSearchParams({
    page: String(filters.page),
    limit: String(filters.limit ?? 50),
  });
  const group = EVENT_GROUPS[filters.group];
  if (group) params.set('types', group.types.join(','));
  if (filters.from) params.set('from', `${filters.from}T00:00:00`);
  if (filters.to) params.set('to', `${filters.to}T23:59:59.999`);
  return `/audit?${params.toString()}`;
}

/** A moment as «31/10/2026, 14:05». */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --- assistant usage -------------------------------------------------------------------------

export type TraceOutcome =
  | 'SUCCESS'
  | 'AMBIGUOUS'
  | 'REJECTED'
  | 'SECURITY_REJECTED'
  | 'ERROR'
  | 'LLM_DISABLED'
  | 'DETERMINISTIC_FALLBACK';

export type Trace = {
  requestId: string;
  model: string;
  provider: string;
  latencyMs: number;
  outcome: TraceOutcome;
  action?: string | null;
  tokens?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  timestamp: string;
};

export const OUTCOME_LABELS: Record<TraceOutcome, string> = {
  SUCCESS: 'riuscita',
  AMBIGUOUS: 'richiesta poco chiara',
  REJECTED: 'non eseguibile',
  SECURITY_REJECTED: 'bloccata per sicurezza',
  ERROR: 'errore',
  LLM_DISABLED: 'assistente spento',
  DETERMINISTIC_FALLBACK: 'risposta senza IA',
};

export function isProblem(outcome: TraceOutcome): boolean {
  return outcome === 'ERROR' || outcome === 'SECURITY_REJECTED';
}

// --- settings --------------------------------------------------------------------------------

export type Frequency = 'daily' | 'weekly' | 'monthly';

export type OrganizationType =
  | 'COMPANY'
  | 'COOPERATIVE'
  | 'NETWORK'
  | 'CONSORTIUM'
  | 'TRADE_ASSOCIATION'
  | 'ASSOCIATION'
  | 'PROFESSIONAL_FIRM'
  | 'OTHER';

export const ORGANIZATION_TYPE_LABELS: Record<OrganizationType, string> = {
  COMPANY: 'Azienda',
  COOPERATIVE: 'Cooperativa',
  NETWORK: "Rete d'impresa",
  CONSORTIUM: 'Consorzio',
  TRADE_ASSOCIATION: 'Associazione di categoria',
  ASSOCIATION: 'Associazione',
  PROFESSIONAL_FIRM: 'Studio professionale',
  OTHER: 'Altro',
};

export type Settings = {
  id: string;
  name: string;
  type: OrganizationType;
  scheduledExport: { enabled: boolean; frequency: Frequency };
  reminderDays: number[];
};
