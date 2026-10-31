/** The platform console (FE7, docs/PROGETTO_FRONTEND_V2.md §5), as the API returns it. */

import { ORGANIZATION_TYPE_LABELS as TYPE_LABELS, type OrganizationType } from './organization';

export { TYPE_LABELS, type OrganizationType };

export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'PENDING_DELETION';

/** Types in the order of the select: the most common first. */
export const TYPES: OrganizationType[] = [
  'COMPANY',
  'COOPERATIVE',
  'NETWORK',
  'CONSORTIUM',
  'TRADE_ASSOCIATION',
  'ASSOCIATION',
  'PROFESSIONAL_FIRM',
  'OTHER',
];

export const STATUS_LABELS: Record<OrganizationStatus, string> = {
  ACTIVE: 'attiva',
  SUSPENDED: 'sospesa',
  DEACTIVATED: 'disattivata',
  PENDING_DELETION: 'in cancellazione',
};

export type OrganizationRow = {
  id: string;
  name: string;
  type: OrganizationType;
  status: OrganizationStatus;
  createdAt: string;
  members: number;
  practices: number;
  lastActivityAt: string | null;
};

export type OrganizationPage = {
  items: OrganizationRow[];
  total: number;
  page: number;
  totalPages: number;
};

export type OrganizationDetail = OrganizationRow & {
  module: string;
  scheduledExport: boolean;
  webhook: boolean;
  deactivatedAt: string | null;
  administrators: Array<{ email: string | null; since: string }>;
  pendingInvitations: number;
};

export type PlatformAuditRow = {
  id: string;
  at: string;
  action: string;
  actorEmail: string | null;
  organization: { id: string; name: string | null } | null;
  targetEmail: string | null;
  details: Partial<Record<'name' | 'type' | 'reason' | 'via', string>>;
};

export type PlatformAuditPage = {
  items: PlatformAuditRow[];
  total: number;
  page: number;
  totalPages: number;
};

/** A fresh code that confirms a critical action (G2). */
export type Verification = { challengeId: string; code: string };

export function organizationsQuery(filters: {
  page: number;
  search: string;
  type: OrganizationType | '';
  status: OrganizationStatus | '';
}): string {
  const params = new URLSearchParams({ page: String(filters.page), limit: '25' });
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.type) params.set('type', filters.type);
  if (filters.status) params.set('status', filters.status);
  return `/platform/organizations?${params.toString()}`;
}

/** What happened, in one Italian sentence. */
export function describePlatformAction(row: PlatformAuditRow): string {
  const org = row.organization ? `«${row.organization.name ?? 'organizzazione eliminata'}»` : '';
  switch (row.action) {
    case 'ORGANIZATION_CREATED':
      return `Creata l'organizzazione ${org}${
        row.details.type && row.details.type in TYPE_LABELS
          ? ` (${TYPE_LABELS[row.details.type as OrganizationType].toLowerCase()})`
          : ''
      }`;
    case 'FIRST_ADMIN_INVITED':
      return `Invitato il primo amministratore di ${org}`;
    case 'ORGANIZATION_SUSPENDED':
      return `Sospesa ${org}${row.details.reason ? `: ${row.details.reason}` : ''}`;
    case 'ORGANIZATION_REACTIVATED':
      return `Riattivata ${org}`;
    case 'PLATFORM_ADMIN_GRANTED':
      return `${row.targetEmail ?? 'Una persona'} è ora gestore della piattaforma`;
    case 'PLATFORM_ADMIN_REVOKED':
      return `${row.targetEmail ?? 'Una persona'} non è più gestore della piattaforma`;
    default:
      return row.action.toLowerCase().replace(/_/g, ' ');
  }
}
