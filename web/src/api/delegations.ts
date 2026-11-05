/** MF8 (decision D3): delegations given and received. */

import type { OrganizationType } from './organization';
import type { Practice } from './practices';

export type GrantOperation = 'READ' | 'CREATE' | 'UPDATE' | 'APPROVE' | 'DELETE' | 'EXPORT';
export type GrantState = 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED';
export type BeneficiaryStatus = 'PROPOSED' | 'ACTIVE' | 'REVOKED';

export type Beneficiary = { userId: string; email: string | null; status: BeneficiaryStatus };

export type IssuedGrant = {
  id: string;
  granteeType: 'USER' | 'ORGANIZATION';
  grantee: { orgId?: string; name: string; type?: OrganizationType };
  operations: GrantOperation[];
  validFrom: string;
  validUntil: string;
  state: GrantState;
  revokedAt: string | null;
  beneficiaries: Beneficiary[];
};

export type ReceivedGrant = {
  id: string;
  grantor: { orgId: string; name: string };
  granteeType: 'USER' | 'ORGANIZATION';
  operations: GrantOperation[];
  validUntil: string;
  state: GrantState;
  usable: boolean;
  beneficiaries: Beneficiary[];
};

export type DelegatedPage = {
  items: Practice[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  delegation: { grantorName: string; operations: GrantOperation[]; validUntil: string };
};

/** Operations offered in this version (the backend refuses the others). */
export const OFFERED_OPERATIONS: GrantOperation[] = ['READ', 'UPDATE', 'EXPORT'];

export const OPERATION_LABELS: Record<GrantOperation, string> = {
  READ: 'vedere le pratiche e i documenti',
  CREATE: 'creare pratiche',
  UPDATE: 'cambiare lo stato delle pratiche',
  APPROVE: 'approvare',
  DELETE: 'cancellare',
  EXPORT: 'esportare le pratiche',
};

export const STATE_NAMES: Record<GrantState, string> = {
  ACTIVE: 'attiva',
  EXPIRED: 'scaduta',
  SUSPENDED: 'sospesa',
  REVOKED: 'revocata',
};

export const BENEFICIARY_NAMES: Record<BeneficiaryStatus, string> = {
  PROPOSED: 'da approvare',
  ACTIVE: 'approvato',
  REVOKED: 'rimosso',
};

/** D3: 12 months at most, 3 with export. */
export function maxMonths(operations: GrantOperation[]): number {
  return operations.includes('EXPORT') || operations.includes('DELETE') ? 3 : 12;
}

/** The end date `months` from today, as YYYY-MM-DD. */
export function endDateIn(months: number, today = new Date()): string {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() + months, today.getDate()));
  return d.toISOString().slice(0, 10);
}

export const DURATIONS = [1, 3, 6, 12] as const;
