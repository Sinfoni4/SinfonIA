import type { UserRole } from '@prisma/client';

/**
 * Permission catalog: the only place that says what each role may do.
 *
 * It mirrors the behaviour before the central authorization service
 * (tests/authz.characterization.test.ts), with the approved changes C2 (chat view) and D5
 * (exports). C3 (deletion) is still to be decided, see docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md.
 */

export const PERMISSIONS = [
  'practice.create',
  'practice.read',
  'practice.export',
  'practice.transition',
  'practice.delete',
  'attachment.create',
  'attachment.read',
  'attachment.validate',
  'ai.execute',
  'ai.traces.read',
  'compliance.read',
  'compliance.manage',
  'audit.read',
  'members.read',
  'members.manage',
  'organization.manage',
  'assistance.request',
  'assistance.manage',
  'practice.assign',
  'network.manage',
  'network.stats',
  'memberships.manage',
  'grant.issue',
  'grant.beneficiaries',
  'grant.use',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Objects a granted permission reaches: the caller's own ones, or the whole tenant. */
export type PermissionScope = 'own' | 'tenant';

const STAFF: Partial<Record<Permission, PermissionScope>> = {
  'practice.create': 'own',
  'practice.read': 'tenant',
  'practice.export': 'tenant',
  'practice.transition': 'tenant',
  // C3 pending: today any role deletes its own practices from chat, without confirmation.
  'practice.delete': 'own',
  // Attachments go only to the uploader's own practices, whatever the role.
  'attachment.create': 'own',
  'attachment.read': 'tenant',
  // A1: confirming or correcting the data read from documents of the organization.
  'attachment.validate': 'tenant',
  // The AI works on the caller's own practices, whatever the role.
  'ai.execute': 'own',
  'ai.traces.read': 'tenant',
  'compliance.read': 'tenant',
  'compliance.manage': 'tenant',
  // H10: anyone asks an operator for help from the chat; staff handle the requests.
  'assistance.request': 'own',
  'assistance.manage': 'tenant',
  // MF8: using a delegation received; the delegation itself decides what is allowed.
  'grant.use': 'own',
  // A4: who follows a practice of the organization.
  'practice.assign': 'tenant',
};

export const ROLE_PERMISSIONS: Record<UserRole, Partial<Record<Permission, PermissionScope>>> = {
  ADMIN: {
    ...STAFF,
    'audit.read': 'tenant',
    'members.read': 'tenant',
    'members.manage': 'tenant',
    // Name and scheduled export of the organization (P12); its type is the platform's.
    'organization.manage': 'tenant',
    // MF9: members of a network (invite, end) and memberships of a company (confirm, leave).
    'network.manage': 'tenant',
    'memberships.manage': 'tenant',
    'network.stats': 'tenant',
    // MF8 (D3): delegations given by the organization, and the people named for those received.
    'grant.issue': 'tenant',
    'grant.beneficiaries': 'tenant',
  },
  // D5: an OPERATOR exports its own practices; the organization only with an extra permission.
  // MF9: operators of a network read its aggregate statistics (D4).
  OPERATOR: { ...STAFF, 'practice.export': 'own', 'network.stats': 'tenant' },
  MEMBER: {
    'practice.create': 'own',
    'practice.read': 'own',
    'practice.export': 'own',
    'practice.delete': 'own',
    'attachment.create': 'own',
    'attachment.read': 'own',
    'attachment.validate': 'own',
    'ai.execute': 'own',
    'compliance.read': 'own',
    'assistance.request': 'own',
    'grant.use': 'own',
  },
};

/**
 * Organization-wide scopes an ORG_ADMIN may grant on top of a role (membership.extra_permissions,
 * stored as `<permission>:tenant`), and to which roles. Nothing else can be widened.
 */
export const GRANTABLE_TENANT_SCOPES: Partial<Record<Permission, readonly UserRole[]>> = {
  'practice.export': ['OPERATOR'],
};

export function tenantScopeKey(permission: Permission): string {
  return `${permission}:tenant`;
}

// --- B2 (H6): roles defined by an organization ----------------------------------------------

/** The permissions of a custom role with their scope; what is missing is not granted. */
export type CustomPermissions = Partial<Record<Permission, PermissionScope>>;

const SCOPES: readonly PermissionScope[] = ['own', 'tenant'];

/**
 * Reads the stored permissions of a custom role (`<permission>:<scope>`). Unknown entries are
 * dropped: a permission removed from the catalog can never be granted by an old row.
 */
export function parseCustomPermissions(stored: readonly string[]): CustomPermissions {
  const out: CustomPermissions = {};
  for (const entry of stored) {
    const [permission, scope] = entry.split(':');
    if (
      (PERMISSIONS as readonly string[]).includes(permission ?? '') &&
      (SCOPES as readonly string[]).includes(scope ?? '')
    ) {
      out[permission as Permission] = scope as PermissionScope;
    }
  }
  return out;
}

export function serializeCustomPermissions(permissions: CustomPermissions): string[] {
  return PERMISSIONS.filter((p) => permissions[p] !== undefined).map(
    (p) => `${p}:${permissions[p]}`,
  );
}

/** The narrower of two scopes: a custom role never widens its base role. */
export function narrowerScope(a: PermissionScope, b: PermissionScope): PermissionScope {
  return a === 'own' || b === 'own' ? 'own' : 'tenant';
}

/**
 * The problems of a custom role, in Italian, or an empty list: every permission must be one of
 * the base role, with the same scope or a narrower one.
 */
export function customRoleProblems(baseRole: UserRole, permissions: CustomPermissions): string[] {
  const ceiling = ROLE_PERMISSIONS[baseRole];
  const problems: string[] = [];
  for (const [permission, scope] of Object.entries(permissions) as Array<
    [Permission, PermissionScope]
  >) {
    const allowed = ceiling[permission];
    if (!allowed) problems.push(`«${permission}» non fa parte del ruolo di base`);
    else if (allowed === 'own' && scope === 'tenant') {
      problems.push(`«${permission}» vale solo per le proprie pratiche nel ruolo di base`);
    }
  }
  if (Object.keys(permissions).length === 0) problems.push('Scegli almeno un permesso');
  return problems;
}
