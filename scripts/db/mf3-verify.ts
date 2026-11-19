/**
 * Identity integrity checks (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §9.3), on the model left
 * after the MF12 contraction: every person has a membership and every chat account one active
 * link. Prints counts and outcomes only.
 *
 * Env: DATABASE_URL. Usage: npx tsx scripts/db/mf3-verify.ts
 */
import { pathToFileURL } from 'node:url';

import pg from 'pg';

export type IdentityCheck = { name: string; ok: boolean; count: number; detail: string };

const CHECKS: Array<{ name: string; sql: string; detail: string; informational?: boolean }> = [
  {
    // MF12: a person exists only through the organizations it belongs to.
    name: 'users_without_membership',
    detail: 'users with no membership at all',
    sql: `SELECT count(*)::int n FROM "user" u
           WHERE NOT EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id)`,
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
