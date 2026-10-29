/**
 * MF1, test #13 of the plan: the effective privileges of the three database roles, on a temporary
 * database migrated from scratch. Needs a superuser connection (DB_ADMIN_URL, or DATABASE_URL when
 * it is a superuser); skipped otherwise.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyRoles, roleNames } from '../scripts/db/roles.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';

const ADMIN_URL = process.env.DB_ADMIN_URL ?? process.env.DATABASE_URL;

async function isSuperuser(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    const { rows } = await c.query<{ su: boolean }>(
      'SELECT rolsuper su FROM pg_roles WHERE rolname = current_user',
    );
    return rows[0]?.su === true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

const enabled = await isSuperuser(ADMIN_URL);

function withDatabase(url: string, database: string, user?: { name: string; password: string }) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** Runs a statement as a role; returns the SQLSTATE of the error, or "ok". */
async function attempt(url: string, sql: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  } finally {
    await c.end();
  }
}

describe.runIf(enabled)('database roles (MF1)', () => {
  const suffix = randomBytes(4).toString('hex');
  const database = `mf1_roles_${suffix}`;
  const roles = roleNames(`mf1t_${suffix}`);
  const passwords = {
    owner: randomBytes(12).toString('hex'),
    app: randomBytes(12).toString('hex'),
    backup: randomBytes(12).toString('hex'),
  };
  let adminDb: string;
  let ownerUrl: string;
  let appUrl: string;
  let backupUrl: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();
    adminDb = withDatabase(ADMIN_URL!, database);
    // Same order as CI: migrations first (as the administrator), then the role model.
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: adminDb, MIGRATION_DATABASE_URL: adminDb },
      shell: true,
      encoding: 'utf8',
    });
    if (migrate.status !== 0) throw new Error('Migrations failed on the temporary database');
    await applyRoles(adminDb, roles, passwords);
    ownerUrl = withDatabase(ADMIN_URL!, database, { name: roles.owner, password: passwords.owner });
    appUrl = withDatabase(ADMIN_URL!, database, { name: roles.app, password: passwords.app });
    backupUrl = withDatabase(ADMIN_URL!, database, {
      name: roles.backup,
      password: passwords.backup,
    });
  }, 180_000);

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of [roles.app, roles.backup, roles.owner]) {
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('lets the application work on data through its normal services', async () => {
    const prisma = createPrismaClient(appUrl);
    try {
      const tenant = await new TenantRepository(prisma).createTenant({ name: 'Ruoli' });
      const user = await new UserRepository(prisma).createUser(tenant.id, {
        email: 'ruoli@test.local',
        role: 'ADMIN',
      });
      const service = new PracticeApplicationService(prisma);
      const practice = await service.createPractice({
        tenantId: tenant.id,
        userId: user.id,
        name: 'Pratica ruoli',
        kind: 'music',
      });
      // Update of the practice and INSERT into the audit log.
      const moved = await service.transitionPractice({
        tenantId: tenant.id,
        practiceId: practice.id,
        nextState: 'VALIDATED',
        userId: user.id,
      });
      expect(moved.status).toBe('VALIDATED');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('denies the application every privilege beyond data', async () => {
    const denied = '42501'; // insufficient_privilege
    expect(await attempt(appUrl, 'CREATE TABLE intrusa (id int)')).toBe(denied);
    expect(await attempt(appUrl, 'DROP TABLE practice')).toBe(denied);
    expect(await attempt(appUrl, 'TRUNCATE practice')).toBe(denied);
    expect(await attempt(appUrl, 'ALTER TABLE audit_log DISABLE TRIGGER USER')).toBe(denied);
    // Audit log: append-only by privileges, before the trigger is even reached.
    expect(await attempt(appUrl, 'UPDATE audit_log SET event_type = event_type')).toBe(denied);
    expect(await attempt(appUrl, 'DELETE FROM audit_log')).toBe(denied);
    expect(await attempt(appUrl, 'SELECT count(*) FROM _prisma_migrations')).toBe(denied);
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    const { rows } = await c.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    await c.end();
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  });

  it('lets the backup role read everything and write nothing', async () => {
    expect(await attempt(backupUrl, 'SELECT count(*) FROM practice')).toBe('ok');
    expect(await attempt(backupUrl, 'SELECT count(*) FROM audit_log')).toBe('ok');
    expect(
      await attempt(backupUrl, "INSERT INTO tenant (id, name) VALUES (gen_random_uuid(), 'x')"),
    ).toBe('42501');
  });

  it('lets only the owner change the schema and run migrations', async () => {
    expect(await attempt(ownerUrl, 'CREATE TABLE prova_owner (id int)')).toBe('ok');
    expect(await attempt(ownerUrl, 'DROP TABLE prova_owner')).toBe('ok');
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: ownerUrl },
      shell: true,
      encoding: 'utf8',
    });
    expect(migrate.status).toBe(0);
    // A table created later by the owner is usable by the application (default privileges).
    expect(await attempt(ownerUrl, 'CREATE TABLE futura (id int)')).toBe('ok');
    expect(await attempt(appUrl, 'INSERT INTO futura VALUES (1)')).toBe('ok');
  }, 120_000);
});
