/**
 * MF1 — separate PostgreSQL roles (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §6).
 *
 * - <prefix>_owner: owns the schema; used only to run migrations.
 * - <prefix>_app: the application. Reads and writes data; on audit_log only INSERT and SELECT;
 *   no DDL, no TRUNCATE, cannot disable triggers (not owner), no superuser, no BYPASSRLS.
 * - <prefix>_backup: read-only, for pg_dump.
 *
 * Idempotent: running it again re-applies the same state. Needs a superuser connection.
 */
import pg from 'pg';

export type RoleNames = { owner: string; app: string; backup: string };

export function roleNames(prefix: string): RoleNames {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix)) throw new Error('Invalid role prefix');
  return { owner: `${prefix}_owner`, app: `${prefix}_app`, backup: `${prefix}_backup` };
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Statements that bring a database to the role model; passwords appear only here. */
export function roleStatements(
  database: string,
  roles: RoleNames,
  passwords: Record<keyof RoleNames, string>,
): string[] {
  const { owner, app, backup } = roles;
  const login = (role: string, password: string) => [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
         CREATE ROLE ${ident(role)};
       END IF;
     END $$`,
    `ALTER ROLE ${ident(role)} WITH LOGIN PASSWORD ${literal(password)}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`,
  ];
  return [
    ...login(owner, passwords.owner),
    ...login(app, passwords.app),
    ...login(backup, passwords.backup),

    // Ownership: database, schema and every object in it (tables carry indexes and triggers).
    `ALTER DATABASE ${ident(database)} OWNER TO ${ident(owner)}`,
    `ALTER SCHEMA public OWNER TO ${ident(owner)}`,
    `DO $$ DECLARE r record; BEGIN
       FOR r IN SELECT c.relname, c.relkind FROM pg_class c
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','S')
       LOOP
         EXECUTE format(CASE r.relkind WHEN 'S' THEN 'ALTER SEQUENCE public.%I OWNER TO %I'
                                       WHEN 'v' THEN 'ALTER VIEW public.%I OWNER TO %I'
                                       WHEN 'm' THEN 'ALTER MATERIALIZED VIEW public.%I OWNER TO %I'
                                       ELSE 'ALTER TABLE public.%I OWNER TO %I' END,
                        r.relname, ${literal(owner)});
       END LOOP;
       FOR r IN SELECT t.typname FROM pg_type t
                 WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
       LOOP
         EXECUTE format('ALTER TYPE public.%I OWNER TO %I', r.typname, ${literal(owner)});
       END LOOP;
       FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                    WHERE d.objid = p.oid AND d.deptype = 'e')
       LOOP
         EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.sig, ${literal(owner)});
       END LOOP;
     END $$`,

    // Connections: only the three roles (superusers are not affected).
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(database)} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(owner)}, ${ident(app)}, ${ident(backup)}`,
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA public TO ${ident(app)}, ${ident(backup)}`,

    // Application: data only.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident(app)}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(app)}`,
    // The audit log is append-only for the application, not just through the trigger.
    `REVOKE UPDATE, DELETE ON public.audit_log FROM ${ident(app)}`,
    // Migration history is for the owner only.
    `REVOKE ALL ON public._prisma_migrations FROM ${ident(app)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(app)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${ident(app)}`,

    // Backup: read everything, write nothing.
    `GRANT pg_read_all_data TO ${ident(backup)}`,
  ];
}

export async function applyRoles(
  adminUrl: string,
  roles: RoleNames,
  passwords: Record<keyof RoleNames, string>,
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string; su: boolean }>(
      'SELECT current_database() db, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) su',
    );
    if (!rows[0]?.su) throw new Error('A superuser connection is required');
    await client.query('BEGIN');
    for (const sql of roleStatements(rows[0].db, roles, passwords)) await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
