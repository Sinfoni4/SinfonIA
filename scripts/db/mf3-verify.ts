/**
 * MF3 integrity checks (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §9.3): the new identity tables
 * must mirror the legacy columns the application still writes. Prints counts and outcomes only.
 *
 * Env: DATABASE_URL. Usage: npx tsx scripts/db/mf3-verify.ts
 */
import { pathToFileURL } from 'node:url';

import pg from 'pg';

export type IdentityCheck = { name: string; ok: boolean; count: number; detail: string };

const CHECKS: Array<{ name: string; sql: string; detail: string; informational?: boolean }> = [
  {
    // Since MF4 roles and statuses live in the membership: only its existence is checked.
    name: 'users_without_membership',
    detail: 'users with no membership at all in their legacy tenant',
    sql: `SELECT count(*)::int n FROM "user" u
           WHERE NOT EXISTS (SELECT 1 FROM membership m
                              WHERE m.user_id = u.id AND m.org_id = u.tenant_id)`,
  },
  {
    // Since MF4 a person can belong to several organizations: no longer an inconsistency.
    name: 'people_in_several_organizations',
    detail: 'ACTIVE memberships outside the legacy tenant of their user: informational',
    informational: true,
    sql: `SELECT count(*)::int n FROM membership m JOIN "user" u ON u.id = m.user_id
           WHERE m.status = 'ACTIVE' AND m.org_id <> u.tenant_id`,
  },
  {
    // A link revoked since MF4 is legitimate; an account never mirrored is not.
    name: 'telegram_ids_without_link',
    detail: 'Telegram ids that never had a channel identity',
    sql: `SELECT count(DISTINCT u.telegram_id)::int n FROM "user" u
           WHERE u.telegram_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM channel_identity c
                              WHERE c.channel = 'TELEGRAM' AND c.external_id = u.telegram_id)`,
  },
  {
    name: 'telegram_link_not_most_recent_user',
    detail: 'active Telegram links not held by the most recent user with that id (legacy rule)',
    sql: `SELECT count(*)::int n FROM channel_identity c
           WHERE c.channel = 'TELEGRAM' AND c.revoked_at IS NULL
             AND c.user_id <> (SELECT u.id FROM "user" u WHERE u.telegram_id = c.external_id
                                ORDER BY u.created_at DESC LIMIT 1)`,
  },
  {
    name: 'whatsapp_without_link',
    detail: 'WhatsApp identities that never had a channel identity',
    sql: `SELECT count(*)::int n FROM whatsapp_identity w
           WHERE NOT EXISTS (SELECT 1 FROM channel_identity c
                              WHERE c.channel = 'WHATSAPP' AND c.external_id = w.phone_number)`,
  },
  {
    name: 'duplicate_active_links',
    detail: 'chat accounts with more than one active link (must be impossible)',
    sql: `SELECT count(*)::int n FROM (SELECT channel, external_id FROM channel_identity
                                       WHERE revoked_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1) d`,
  },
  {
    name: 'telegram_ids_shared_by_users',
    detail:
      'Telegram ids used by several legacy users (one person in several tenants): informational',
    informational: true,
    sql: `SELECT count(*)::int n FROM (SELECT telegram_id FROM "user" WHERE telegram_id IS NOT NULL
                                       GROUP BY 1 HAVING count(*) > 1) d`,
  },
];

export async function verifyIdentityModel(client: pg.Client): Promise<IdentityCheck[]> {
  const out: IdentityCheck[] = [];
  for (const check of CHECKS) {
    const { rows } = await client.query<{ n: number }>(check.sql);
    const count = rows[0]?.n ?? -1;
    out.push({
      name: check.name,
      ok: check.informational ? true : count === 0,
      count,
      detail: check.detail,
    });
  }
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const checks = await verifyIdentityModel(client);
    await client.query('COMMIT');
    for (const c of checks)
      console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.count} — ${c.detail}`);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`Verification failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 2;
  });
}
