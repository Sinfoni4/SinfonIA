import { poolOf } from '../../data/db/prisma.js';

import {
  GRANTABLE_TENANT_SCOPES,
  ROLE_PERMISSIONS,
  tenantScopeKey,
  type Permission,
  type PermissionScope,
} from './permissions.js';

import type { PrismaClient, UserRole } from '@prisma/client';

/** Who is acting: always resolved by the backend, never taken from what the client says. */
export type Principal = {
  tenantId: string;
  userId: string;
  role: UserRole;
  /** Extra scopes granted by an ORG_ADMIN on the membership (D5), e.g. `practice.export:tenant`. */
  extraPermissions?: readonly string[];
};

/**
 * The scheduler acting for one organization (§5): no person and no role behind it, limited to
 * that organization and to the task it runs. It never stands in for a member.
 */
export type SystemActor = { kind: 'system'; orgId: string; task: string };

export type Grant = { principal: Principal; permission: Permission; scope: PermissionScope };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MEMBERSHIP_SQL = `SELECT m."role", m."extra_permissions" FROM "membership" m
   JOIN "user" u ON u."id" = m."user_id"
   JOIN "tenant" t ON t."id" = m."org_id"
  WHERE m."user_id" = $1 AND m."org_id" = $2 AND m."status" = 'ACTIVE'
    AND u."status" = 'ACTIVE' AND t."status" = 'ACTIVE' AND u."auth_version" = $3`;

/** Message starts with PERMISSION_DENIED: chat channels turn it into the Italian reply. */
export class PermissionDeniedError extends Error {
  constructor(readonly permission: Permission) {
    super(`PERMISSION_DENIED: ${permission}`);
    this.name = 'PermissionDeniedError';
  }
}

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role][permission] !== undefined;
}

/** Grants the permission with its scope, or throws PermissionDeniedError. */
export function authorize(principal: Principal, permission: Permission): Grant {
  const base = ROLE_PERMISSIONS[principal.role][permission];
  if (!base) throw new PermissionDeniedError(permission);
  // An extra scope widens "own" to the organization only where the catalog allows it for the role.
  const widened =
    base === 'own' &&
    GRANTABLE_TENANT_SCOPES[permission]?.includes(principal.role) === true &&
    principal.extraPermissions?.includes(tenantScopeKey(permission)) === true;
  return { principal, permission, scope: widened ? 'tenant' : base };
}

/**
 * The user filter a grant imposes on a query: the caller for "own" grants, otherwise whatever the
 * caller asked for (undefined = the whole tenant).
 */
export function scopedUserId(grant: Grant, requestedUserId?: string): string | undefined {
  return grant.scope === 'own' ? grant.principal.userId : requestedUserId;
}

/**
 * Current role of a user in a tenant, read from the database at every request. Null when the user
 * does not exist in that tenant. `tokenRole` is what the token claims: production resolvers ignore
 * it (only tests without a database rely on it).
 */
export type PrincipalResolver = (identity: {
  tenantId: string;
  userId: string;
  tokenRole: UserRole;
  /** auth_version in the token: an older one means a revoked token (MF5). */
  authVersion?: number;
  /** Session in the token (MF6 logins): must exist, be open and not expired. */
  sessionId?: string;
}) => Promise<Principal | null>;

export function createPrismaPrincipalResolver(
  prisma: Pick<PrismaClient, 'membership'>,
): PrincipalResolver {
  // Runs on every request: a prepared statement on the client's own pg pool when available
  // (no ORM overhead), the same query through Prisma otherwise.
  const pool = poolOf(prisma);
  const find = pool
    ? async (userId: string, tenantId: string, authVersion: number, sessionId?: string) => {
        // One query (unique index on user_id, org_id): membership, statuses, token version and,
        // when present, the session.
        const { rows } = await pool.query<{ role: UserRole; extra_permissions: string[] }>(
          sessionId
            ? {
                name: 'authz_membership_session',
                text: `${MEMBERSHIP_SQL} AND EXISTS (
                         SELECT 1 FROM "session" s
                          WHERE s."id" = $4 AND s."user_id" = u."id" AND s."revoked_at" IS NULL
                            AND s."expires_at" > now() AND s."auth_version" = u."auth_version")`,
                values: [userId, tenantId, authVersion, sessionId],
              }
            : {
                name: 'authz_membership',
                text: MEMBERSHIP_SQL,
                values: [userId, tenantId, authVersion],
              },
        );
        const row = rows[0];
        return row ? { role: row.role, extraPermissions: row.extra_permissions } : null;
      }
    : async (userId: string, tenantId: string, authVersion: number, sessionId?: string) => {
        const row = await prisma.membership.findFirst({
          where: {
            userId,
            orgId: tenantId,
            status: 'ACTIVE',
            user: {
              status: 'ACTIVE',
              authVersion,
              ...(sessionId
                ? {
                    sessions: {
                      some: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
                    },
                  }
                : {}),
            },
            org: { status: 'ACTIVE' },
          },
          select: { role: true, extraPermissions: true },
        });
        return row ? { role: row.role, extraPermissions: row.extraPermissions } : null;
      };

  return async ({ tenantId, userId, authVersion = 0, sessionId }) => {
    // The role of the ACTIVE membership in the token's organization (MF4); a suspended person or
    // organization, or a revoked membership, gives no access.
    if (!UUID.test(userId) || !UUID.test(tenantId)) return null;
    if (sessionId !== undefined && !UUID.test(sessionId)) return null;
    const found = await find(userId, tenantId, authVersion, sessionId);
    return found ? { tenantId, userId, ...found } : null;
  };
}
