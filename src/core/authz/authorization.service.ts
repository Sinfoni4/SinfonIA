import { poolOf } from '../../data/db/prisma.js';

import { ROLE_PERMISSIONS, type Permission, type PermissionScope } from './permissions.js';

import type { PrismaClient, UserRole } from '@prisma/client';

/** Who is acting: always resolved by the backend, never taken from what the client says. */
export type Principal = {
  tenantId: string;
  userId: string;
  role: UserRole;
};

export type Grant = { principal: Principal; permission: Permission; scope: PermissionScope };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const scope = ROLE_PERMISSIONS[principal.role][permission];
  if (!scope) throw new PermissionDeniedError(permission);
  return { principal, permission, scope };
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
}) => Promise<Principal | null>;

export function createPrismaPrincipalResolver(
  prisma: Pick<PrismaClient, 'membership'>,
): PrincipalResolver {
  // Runs on every request: a prepared statement on the client's own pg pool when available
  // (no ORM overhead), the same query through Prisma otherwise.
  const pool = poolOf(prisma);
  const find = pool
    ? async (userId: string, tenantId: string) => {
        // Unique index (user_id, org_id): one lookup, as before MF4.
        const { rows } = await pool.query<{ role: UserRole }>({
          name: 'authz_membership',
          text: `SELECT m."role" FROM "membership" m
                   JOIN "user" u ON u."id" = m."user_id"
                   JOIN "tenant" t ON t."id" = m."org_id"
                  WHERE m."user_id" = $1 AND m."org_id" = $2 AND m."status" = 'ACTIVE'
                    AND u."status" = 'ACTIVE' AND t."status" = 'ACTIVE'`,
          values: [userId, tenantId],
        });
        return rows[0]?.role ?? null;
      }
    : async (userId: string, tenantId: string) =>
        (
          await prisma.membership.findFirst({
            where: {
              userId,
              orgId: tenantId,
              status: 'ACTIVE',
              user: { status: 'ACTIVE' },
              org: { status: 'ACTIVE' },
            },
            select: { role: true },
          })
        )?.role ?? null;

  return async ({ tenantId, userId }) => {
    // The role of the ACTIVE membership in the token's organization (MF4); a suspended person or
    // organization, or a revoked membership, gives no access.
    if (!UUID.test(userId) || !UUID.test(tenantId)) return null;
    const role = await find(userId, tenantId);
    return role ? { tenantId, userId, role } : null;
  };
}
