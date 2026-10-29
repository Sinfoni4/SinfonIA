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
  prisma: Pick<PrismaClient, 'user'>,
): PrincipalResolver {
  // Runs on every request: a prepared statement on the client's own pg pool when available
  // (no ORM overhead), the same query through Prisma otherwise.
  const pool = poolOf(prisma);
  const find = pool
    ? async (userId: string) => {
        const { rows } = await pool.query<{ role: UserRole; tenant_id: string }>({
          name: 'authz_principal_by_id',
          text: 'SELECT "role", "tenant_id" FROM "user" WHERE "id" = $1',
          values: [userId],
        });
        return rows[0] ? { role: rows[0].role, tenantId: rows[0].tenant_id } : null;
      }
    : (userId: string) =>
        prisma.user.findUnique({ where: { id: userId }, select: { role: true, tenantId: true } });

  return async ({ tenantId, userId }) => {
    // Primary-key lookup, tenant checked here: about half the cost of a two-column query under
    // load, with the same result (benchmarked for MF2).
    if (!UUID.test(userId)) return null;
    const user = await find(userId);
    return user && user.tenantId === tenantId ? { tenantId, userId, role: user.role } : null;
  };
}
