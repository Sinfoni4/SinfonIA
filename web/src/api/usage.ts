/** AGX-07: usage events of an organization, of a network's companies and of the platform. */

import type { StatsPeriodKind } from './network';

export type UsageKind =
  | 'DOCUMENT_RECEIVED'
  | 'OCR_PAGES'
  | 'AI_CALL'
  | 'AI_TOKENS'
  | 'PRACTICE_OPENED'
  | 'PRACTICE_COMPLETED'
  | 'DOCUMENT_REQUESTED'
  | 'ASSISTANCE_CLOSED';

export const USAGE_LABELS: Record<UsageKind, string> = {
  DOCUMENT_RECEIVED: 'Documenti ricevuti',
  OCR_PAGES: 'Pagine lette con OCR',
  AI_CALL: "Richieste all'assistente",
  AI_TOKENS: "Token dell'assistente",
  PRACTICE_OPENED: 'Pratiche aperte',
  PRACTICE_COMPLETED: 'Pratiche completate',
  DOCUMENT_REQUESTED: 'Documenti richiesti',
  ASSISTANCE_CLOSED: 'Richieste di assistenza chiuse',
};

export type UsagePeriod = { kind: StatsPeriodKind; previous: boolean; from: string; to: string };

export type OrganizationUsage = {
  period: UsagePeriod;
  totals: Array<{ kind: UsageKind; unit: string; quantity: number }>;
  byOthers: Array<{
    orgId: string;
    orgName: string;
    items: Array<{ kind: UsageKind; quantity: number }>;
  }>;
};

export type PlatformUsage = {
  period: UsagePeriod;
  ratesConfigured: boolean;
  rates: Partial<Record<UsageKind, number>>;
  organizations: Array<{
    orgId: string;
    orgName: string;
    items: Array<{ kind: UsageKind; quantity: number; cost: number | null }>;
    cost: number | null;
  }>;
  totals: Array<{ kind: UsageKind; unit: string; quantity: number; cost: number | null }>;
  cost: number | null;
  recent: Array<{
    id: string;
    orgId: string;
    orgName: string;
    actorOrgName: string | null;
    kind: UsageKind;
    quantity: number;
    unit: string;
    occurredAt: string;
    correctionOf: string | null;
    reversed: boolean;
    reason: string | null;
  }>;
};

export function usageQuery(
  base: '/usage' | '/platform/usage',
  kind: StatsPeriodKind,
  previous: boolean,
): string {
  return `${base}?period=${kind}&previous=${String(previous)}`;
}

export function usageLabel(kind: string): string {
  return (USAGE_LABELS as Record<string, string>)[kind] ?? kind;
}

export function formatQuantity(quantity: number): string {
  return quantity.toLocaleString('it-IT');
}

/** An internal cost in euro; `null` (no rate) is «—». */
export function formatCost(cost: number | null): string {
  if (cost === null) return '—';
  return cost.toLocaleString('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}
