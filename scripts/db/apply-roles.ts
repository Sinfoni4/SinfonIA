/**
 * Applies the MF1 role model to one database (see scripts/db/roles.ts).
 *
 * Env: DB_ADMIN_URL (superuser connection to the target database), DB_ROLE_PREFIX (default
 * "sinfonia"), DB_OWNER_PASSWORD, DB_APP_PASSWORD, DB_BACKUP_PASSWORD.
 * Staging is refused unless DB_ROLES_STAGING_APPROVED=yes (separate approval).
 *
 * Usage: npm run db:roles
 */
import { applyRoles, roleNames } from './roles.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const adminUrl = required('DB_ADMIN_URL');
  const database = new URL(adminUrl).pathname.replace(/^\//, '');
  if (/staging/i.test(database) && process.env.DB_ROLES_STAGING_APPROVED !== 'yes') {
    throw new Error('Staging refused: applying roles to staging needs a separate approval');
  }
  const roles = roleNames(process.env.DB_ROLE_PREFIX ?? 'sinfonia');
  await applyRoles(adminUrl, roles, {
    owner: required('DB_OWNER_PASSWORD'),
    app: required('DB_APP_PASSWORD'),
    backup: required('DB_BACKUP_PASSWORD'),
  });
  console.log(
    `Roles applied to ${database}: ${roles.owner} (migrations), ${roles.app} (application), ${roles.backup} (backup)`,
  );
}

main().catch((err: unknown) => {
  console.error(`Roles not applied: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
