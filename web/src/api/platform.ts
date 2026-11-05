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
  /** A03: functions turned off for the organization. */
  disabledFeatures?: string[];
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
  details: Partial<
    Record<'name' | 'type' | 'reason' | 'via' | 'module' | 'organization', string>
  > & {
    disabledFeatures?: string[];
  };
};

/** A02: the sector modules (src/modules on the server). */
export const MODULES = ['generic', 'music', 'agri'] as const;
export type ModuleId = (typeof MODULES)[number];
export const MODULE_LABELS: Record<ModuleId, string> = {
  generic: 'Generico',
  music: 'Musica e spettacolo',
  agri: 'Agricoltura',
};

/** A03: the functions the platform can turn off for one organization. */
export const FEATURES = [
  'ai_chat',
  'documents',
  'deadlines',
  'assistance',
  'exports',
  'delegations',
  'network_stats',
] as const;
export type Feature = (typeof FEATURES)[number];
export const FEATURE_LABELS: Record<Feature, string> = {
  ai_chat: 'Assistente IA nella chat',
  documents: 'Documenti e lettura automatica',
  deadlines: 'Scadenze e promemoria',
  assistance: 'Richieste di assistenza',
  exports: 'Esportazioni',
  delegations: 'Deleghe tra organizzazioni',
  network_stats: 'Statistiche di rete',
};

export function moduleLabel(id: string): string {
  return (MODULE_LABELS as Record<string, string>)[id] ?? id;
}

/** Voce 17: memberships of an organization as the console sees them (names and states only). */
export type OrganizationLink = {
  relationId: string;
  orgId: string;
  name: string;
  status: 'PENDING' | 'ACTIVE';
  since: string;
};

export type OrganizationLinks = {
  isNetwork: boolean;
  members: OrganizationLink[];
  networks: OrganizationLink[];
};

export const LINK_STATUS_LABELS: Record<OrganizationLink['status'], string> = {
  PENDING: 'in attesa di conferma',
  ACTIVE: 'aderente',
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
    case 'ORGANIZATION_MODULES_CHANGED': {
      const off = (row.details.disabledFeatures ?? [])
        .map((f) => (FEATURE_LABELS as Record<string, string>)[f] ?? f)
        .join(', ');
      return `Modulo di ${org}: ${moduleLabel(row.details.module ?? '')}${
        off ? `; spente: ${off}` : '; tutte le funzioni attive'
      }`;
    }
    case 'NETWORK_INVITATION_SENT':
      return `Invitata ${row.details.organization ? `«${row.details.organization}»` : "un'organizzazione"} ad aderire alla rete ${org}`;
    case 'PLATFORM_ADMIN_GRANTED':
      return `${row.targetEmail ?? 'Una persona'} è ora gestore della piattaforma`;
    case 'PLATFORM_ADMIN_REVOKED':
      return `${row.targetEmail ?? 'Una persona'} non è più gestore della piattaforma`;
    default:
      return row.action.toLowerCase().replace(/_/g, ' ');
  }
}
