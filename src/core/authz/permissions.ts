import { SECTOR_FEATURE_IDS, type SectorFeature } from '../../modules/registry.js';

import type { UserRole } from '@prisma/client';

/**
 * Permission catalog: the only place that says what each role may do.
 *
 * It mirrors the behaviour before the central authorization service
 * (tests/authz.characterization.test.ts), with the approved changes C2 (chat view) and D5
 * (exports). C3 (deletion) is still to be decided, see docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md.
 */

const CORE_PERMISSIONS = [
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

/**
 * Each function of a sector (sector-features.ts) has two permissions of its own: reading its
 * register and changing it. They are checked by the register itself, together with whether the
 * function is on for the organization and the channel (dashboard or Mini App).
 */
export type SectorPermission = `${SectorFeature}.read` | `${SectorFeature}.manage`;

export const SECTOR_PERMISSIONS: readonly SectorPermission[] = SECTOR_FEATURE_IDS.flatMap(
  (f) => [`${f}.read`, `${f}.manage`] as const,
);

export const PERMISSIONS = [...CORE_PERMISSIONS, ...SECTOR_PERMISSIONS] as [
  Permission,
  ...Permission[],
];

export type Permission = (typeof CORE_PERMISSIONS)[number] | SectorPermission;

/** The sector function and the operation of a sector permission; undefined for the others. */
export function sectorPermissionOf(
  permission: string,
): { feature: SectorFeature; operation: 'read' | 'manage' } | undefined {
  if (!(SECTOR_PERMISSIONS as readonly string[]).includes(permission)) return undefined;
  const dot = permission.lastIndexOf('.');
  return {
    feature: permission.slice(0, dot) as SectorFeature,
    operation: permission.slice(dot + 1) as 'read' | 'manage',
  };
}

/** The sector permissions at one scope: staff work on the whole register, members on their own. */
function sectorScopes(scope: PermissionScope): Partial<Record<Permission, PermissionScope>> {
  return Object.fromEntries(SECTOR_PERMISSIONS.map((p) => [p, scope]));
}

/**
 * Objects a granted permission reaches: the caller's own ones, or the whole tenant. B2: a custom
 * role may also give `assigned` (own practices plus those assigned to the person) on the
 * permissions in ASSIGNABLE; everywhere else `assigned` counts as `own`.
 */
export type PermissionScope = 'own' | 'assigned' | 'tenant';

/** Permissions on which a custom role may use the `assigned` scope. */
export const ASSIGNABLE: readonly Permission[] = ['practice.read', 'attachment.read'];

const STAFF: Partial<Record<Permission, PermissionScope>> = {
  ...sectorScopes('tenant'),
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
    // A member fills in the registers of the sector functions (e.g. a treatment from the field)
    // and sees only the entries they wrote.
    ...sectorScopes('own'),
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

const SCOPES: readonly PermissionScope[] = ['own', 'assigned', 'tenant'];
const SCOPE_RANK: Record<PermissionScope, number> = { own: 0, assigned: 1, tenant: 2 };

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
      (SCOPES as readonly string[]).includes(scope ?? '') &&
      (scope !== 'assigned' || ASSIGNABLE.includes(permission as Permission))
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
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
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
    else if (scope === 'assigned' && !ASSIGNABLE.includes(permission)) {
      problems.push(`«${permission}» non può valere per le pratiche assegnate`);
    } else if (SCOPE_RANK[scope] > SCOPE_RANK[allowed]) {
      problems.push(`«${permission}» vale solo per le proprie pratiche nel ruolo di base`);
    }
  }
  if (Object.keys(permissions).length === 0) problems.push('Scegli almeno un permesso');
  return problems;
}
