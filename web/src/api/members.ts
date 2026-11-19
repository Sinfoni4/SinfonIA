/** Members and invitations of the organization, as the API returns them (src/core/identity). */

import type { Role } from './client';

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type PersonStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export type Member = {
  userId: string;
  role: Role;
  status: MembershipStatus;
  personStatus: PersonStatus;
  /** Null for accounts created by the chat, which have no real email. */
  email: string | null;
  since: string;
  revokedAt: string | null;
  /** Organization-wide scopes granted by an ADMIN, as `<permission>:tenant`. */
  extraPermissions: string[];
  receivesScheduledExport: boolean;
  /** B2: the custom role of the membership (missing on an older backend). */
  customRole?: { id: string; name: string } | null;
};

// --- B2: custom roles ---------------------------------------------------------------------------

export type PermissionScope = 'own' | 'assigned' | 'tenant';

/** Permissions that a custom role may give on own and assigned practices (as the backend). */
export const ASSIGNABLE = ['practice.read', 'attachment.read'];

export type CustomRole = {
  id: string;
  name: string;
  baseRole: Role;
  permissions: Record<string, PermissionScope>;
  /** Active members who have it. */
  members: number;
};

/** What each base role allows, as GET /roles/catalog returns it. */
export type RoleCatalog = Record<Role, Record<string, PermissionScope>>;

/** The permissions of the catalog in plain Italian; unknown ones show their code. */
export const PERMISSION_LABELS: Record<string, string> = {
  'practice.create': 'Creare pratiche',
  'practice.read': 'Vedere le pratiche',
  'practice.export': 'Esportare le pratiche',
  'practice.transition': 'Cambiare lo stato delle pratiche',
  'practice.delete': 'Eliminare le proprie pratiche',
  'practice.assign': 'Assegnare le pratiche',
  'attachment.create': 'Caricare documenti',
  'attachment.read': 'Vedere i documenti',
  'attachment.validate': 'Verificare i dati letti dai documenti',
  'ai.execute': "Usare l'assistente IA",
  'ai.traces.read': "Vedere l'uso dell'assistente IA",
  'compliance.read': 'Vedere le scadenze',
  'compliance.manage': 'Gestire le scadenze',
  'audit.read': 'Vedere il registro delle attività',
  'members.read': 'Vedere le persone',
  'members.manage': 'Gestire persone e ruoli',
  'organization.manage': "Impostazioni dell'organizzazione",
  'assistance.request': 'Chiedere assistenza',
  'assistance.manage': 'Gestire le richieste di assistenza',
  'network.manage': 'Gestire rete e aderenti',
  'network.stats': 'Vedere le statistiche di rete',
  'memberships.manage': 'Gestire le adesioni alle reti',
  'grant.issue': 'Concedere deleghe',
  'grant.beneficiaries': 'Indicare le persone delle deleghe ricevute',
  'grant.use': 'Usare le deleghe ricevute',
};

export const SCOPE_LABELS: Record<PermissionScope, string> = {
  tenant: "tutta l'organizzazione",
  assigned: 'proprie e assegnate',
  own: 'solo le proprie',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export type Invitation = {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
};

export const ROLES: Role[] = ['ADMIN', 'OPERATOR', 'MEMBER'];

/** Role names with a capital letter, for selects and table cells. */
export const ROLE_NAMES: Record<Role, string> = {
  ADMIN: 'Amministratore',
  OPERATOR: 'Operatore',
  MEMBER: 'Collaboratore',
};

export const ROLE_HINTS: Record<Role, string> = {
  ADMIN: 'tutto, comprese le persone',
  OPERATOR: "pratiche e scadenze dell'azienda",
  MEMBER: 'solo le proprie pratiche',
};

export const INVITATION_LABELS: Record<InvitationStatus, string> = {
  PENDING: 'in attesa',
  ACCEPTED: 'accettato',
  REVOKED: 'revocato',
  EXPIRED: 'scaduto',
};

/** The state of a member in one word: the membership first, then the person's account. */
export function memberState(member: Pick<Member, 'status' | 'personStatus'>): {
  label: string;
  active: boolean;
} {
  if (member.status === 'REVOKED') return { label: 'revocato', active: false };
  if (member.status === 'SUSPENDED') return { label: 'sospeso', active: false };
  if (member.personStatus !== 'ACTIVE') return { label: 'account disattivato', active: false };
  return { label: 'attivo', active: true };
}

/** An OPERATOR allowed by an ADMIN to export the whole organization (D5). */
export function exportsWholeOrganization(member: Pick<Member, 'extraPermissions'>): boolean {
  return member.extraPermissions.includes('practice.export:tenant');
}

/** The invitation token of an acceptance link (`/app/invito#<token>`), if any. */
export function tokenFromHash(hash: string): string {
  return hash.replace(/^#/, '').trim();
}

/** The address of the acceptance page for a token, on this same site. */
export function invitationLink(origin: string, token: string): string {
  return `${origin}/app/invito#${token}`;
}
