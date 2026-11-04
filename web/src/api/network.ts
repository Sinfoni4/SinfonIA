/** MF9: networks, memberships and aggregate statistics (decision D4). */

import type { OrganizationType } from './organization';
import type { PracticeState } from './practices';

export type MembershipStatus = 'PENDING' | 'ACTIVE' | 'ENDED';

export type MemberOrganization = {
  relationId: string;
  orgId: string;
  name: string;
  type: OrganizationType;
  municipality: string | null;
  sector: string | null;
  status: MembershipStatus;
  invitedAt: string;
  startedAt: string | null;
};

export type MyNetwork = {
  relationId: string;
  networkId: string;
  name: string;
  type: OrganizationType;
  status: MembershipStatus;
  invitedAt: string;
  startedAt: string | null;
};

/** A protected value: a number, «meno di 3» (`lt3`), or not available (`null`). */
export type Protected = number | 'lt3' | null;

export type StatsPeriodKind = 'month' | 'quarter' | 'year';

export type NetworkStats = {
  period: { kind: StatsPeriodKind; previous: boolean; from: string; to: string };
  members: { inPeriod: number; activeNow: number; threshold: number; sufficient: boolean };
  practicesByStatus: Array<{ status: PracticeState; value: Protected }>;
  practicesByKind: Array<{ kind: string; value: Protected }>;
  completionDays: Array<{ kind: string; value: Protected }>;
  deadlines: Array<{ category: string; overdue: Protected; dueSoon: Protected }>;
  organic: { valid: Protected; total: number | null };
  documents: { uploaded: Protected; readWithoutCheckPercent: Protected };
  channels: { chatRequests: Protected; dashboardLogins: Protected };
};

export const PERIODS: Array<{ kind: StatsPeriodKind; previous: boolean; label: string }> = [
  { kind: 'month', previous: false, label: 'Mese in corso' },
  { kind: 'month', previous: true, label: 'Mese scorso' },
  { kind: 'quarter', previous: false, label: 'Trimestre in corso' },
  { kind: 'quarter', previous: true, label: 'Trimestre scorso' },
  { kind: 'year', previous: false, label: 'Anno in corso' },
  { kind: 'year', previous: true, label: 'Anno scorso' },
];

export function statsQuery(kind: StatsPeriodKind, previous: boolean): string {
  return `/network/stats?period=${kind}&previous=${String(previous)}`;
}

/** How a protected value is written: «meno di 3», «non disponibile» or the number. */
export function showProtected(value: Protected, suffix = ''): string {
  if (value === null) return 'non disponibile';
  if (value === 'lt3') return 'meno di 3';
  return `${value.toLocaleString('it-IT')}${suffix}`;
}

export const KIND_NAMES: Record<string, string> = {
  generic: 'Generiche',
  music: 'Musicali',
  artist: 'Artisti',
  agri: 'Agricole',
};

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  PENDING: 'in attesa di conferma',
  ACTIVE: 'aderente',
  ENDED: 'chiusa',
};
