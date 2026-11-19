/**
 * Load test of the API (docs/ELENCO_STEP_MANCANTI.md, item 71), with no extra tools.
 *
 * - Only on the TEST database (.env.test, or DATABASE_URL when set): never staging.
 * - Creates an organization «Prova di carico …» with an administrator, `--members` members and
 *   `--practices` practices; they stay in the test database like the suite's (its audit log is
 *   immutable), and `npm run test:db:clean -- --yes` empties it.
 * - Starts the application on `--port` (default 3400) with Telegram, WhatsApp and the AI off and
 *   generous rate limits (the limits are measured by their own tests, not here).
 * - For `--duration` seconds, `--concurrency` clients repeat a mix of the dashboard's main calls
 *   (home, lists, search, detail, audit, assistance, people) and the members' ones (own list,
 *   new practice), each with its own signed token.
 * - Prints count, errors and times (median, 95th and 99th percentile) per call and in total;
 *   exits with code 1 when there are errors or the 95th percentile of the reads is over
 *   `--p95` ms (default 500).
 *
 * Usage: npm run load:test [-- --concurrency 20 --duration 30 --members 50 --practices 5000]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = inline ? inline.split('=')[1] : i >= 0 ? process.argv[i + 1] : undefined;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

const PORT = arg('port', 3400);
const CONCURRENCY = arg('concurrency', 20);
const DURATION_S = arg('duration', 30);
const MEMBERS = arg('members', 50);
const PRACTICES = arg('practices', 5000);
const P95_LIMIT = arg('p95', 500);
const BASE = `http://127.0.0.1:${PORT}`;

function testDatabaseUrl(): string {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const line = readFileSync('.env.test', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('DATABASE_URL='));
    if (!line) throw new Error('DATABASE_URL missing in .env.test');
    url = line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
  }
  if (/staging/i.test(url)) throw new Error('The load test never runs on staging');
  return url;
}

type Call = { name: string; read: boolean; run: (token: string) => Promise<Response> };
type Sample = { ms: number; ok: boolean; status: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function waitReady(app: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`The application exited (${app.exitCode})`);
    try {
      if ((await fetch(`${BASE}/readyz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The application did not become ready in 2 minutes');
}

async function main() {
  const url = testDatabaseUrl();
  // The configuration of the script and of the application: the test database, the rest from
  // .env as usual (secrets stay in memory, never printed).
  process.env.DATABASE_URL = url;
  const { loadConfig } = await import('../src/config/config.js');
  const { createPrismaClient } = await import('../src/data/db/prisma.js');
  const { TenantRepository } = await import('../src/data/repositories/tenant.repository.js');
  const { UserRepository } = await import('../src/data/repositories/user.repository.js');
  const { AuthService } = await import('../src/interface/http/auth/auth.service.js');
  const config = loadConfig();
  const prisma = createPrismaClient(url);
  const auth = new AuthService({
    secret: config.AUTH_SECRET,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    defaultTtlSeconds: 2 * 3600,
  });

  // 1. Data.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`Dati: organizzazione con ${MEMBERS} soci e ${PRACTICES} pratiche...`);
  const tenant = await new TenantRepository(prisma).createTenant({
    name: `Prova di carico ${stamp}`,
  });
  const users = new UserRepository(prisma);
  const admin = await users.createUser(tenant.id, {
    email: `carico-admin-${stamp}@load.local`.toLowerCase(),
    role: 'ADMIN',
  });
  const members: Array<{ id: string }> = [];
  for (let i = 0; i < MEMBERS; i += 1) {
    members.push(
      await users.createUser(tenant.id, {
        email: `carico-socio-${i}-${stamp}@load.local`.toLowerCase(),
        role: 'MEMBER',
      }),
    );
  }
  for (let start = 0; start < PRACTICES; start += 1000) {
    await prisma.practice.createMany({
      data: Array.from({ length: Math.min(1000, PRACTICES - start) }, (_, i) => ({
        tenantId: tenant.id,
        userId: members[(start + i) % members.length].id,
        payload: { name: `Pratica ${String(start + i).padStart(5, '0')}` },
      })),
    });
  }
  const sample = await prisma.practice.findMany({
    where: { tenantId: tenant.id },
    select: { id: true },
    take: 200,
  });
  const token = (userId: string, role: 'ADMIN' | 'MEMBER') =>
    auth.issue({ tenantId: tenant.id, userId, role, authVersion: 0 });
  const adminToken = token(admin.id, 'ADMIN');
  const memberTokens = members.map((m) => token(m.id, 'MEMBER'));

  // 2. Application.
  console.log(`Applicazione: avvio sulla porta ${PORT}...`);
  const app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      SINFONIA_INSTANCE: 'load',
      LOG_LEVEL: 'warn',
      RATE_LIMIT_PER_MINUTE: '1000000',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000000',
      RATE_LIMIT_TENANT_PER_MINUTE: '1000000',
      TELEGRAM_BOT_TOKEN: '',
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_PHONE_NUMBER_ID: '',
      WHATSAPP_APP_SECRET: '',
      WHATSAPP_VERIFY_TOKEN: '',
      ENABLE_LLM: 'false',
    },
  });
  let stderr = '';
  app.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  const get = (path: string) => (t: string) =>
    fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${t}` } });
  const calls: Array<{ call: Call; token: () => string; weight: number }> = [
    {
      call: { name: 'GET /dashboard/summary', read: true, run: get('/dashboard/summary') },
      token: () => adminToken,
      weight: 3,
    },
    {
      call: {
        name: 'GET /practices (pagina)',
        read: true,
        run: (t) => get(`/practices?page=${1 + Math.floor(Math.random() * 20)}&limit=20`)(t),
      },
      token: () => adminToken,
      weight: 4,
    },
    {
      call: {
        name: 'GET /practices (ricerca)',
        read: true,
        run: (t) => get(`/practices?search=Pratica%20${Math.floor(Math.random() * 100)}`)(t),
      },
      token: () => adminToken,
      weight: 2,
    },
    {
      call: {
        name: 'GET /practices/:id',
        read: true,
        run: (t) => get(`/practices/${pick(sample).id}`)(t),
      },
      token: () => adminToken,
      weight: 3,
    },
    {
      call: { name: 'GET /audit', read: true, run: get('/audit') },
      token: () => adminToken,
      weight: 1,
    },
    {
      call: { name: 'GET /assistance', read: true, run: get('/assistance') },
      token: () => adminToken,
      weight: 1,
    },
    {
      call: { name: 'GET /members', read: true, run: get('/members') },
      token: () => adminToken,
      weight: 1,
    },
    {
      call: { name: 'GET /practices (socio)', read: true, run: get('/practices') },
      token: () => pick(memberTokens),
      weight: 4,
    },
    {
      call: {
        name: 'POST /practices (socio)',
        read: false,
        run: (t) =>
          fetch(`${BASE}/practices`, {
            method: 'POST',
            headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: `Carico ${Math.random().toString(36).slice(2, 8)}` }),
          }),
      },
      token: () => pick(memberTokens),
      weight: 1,
    },
  ];
  const bag = calls.flatMap((c) => Array.from({ length: c.weight }, () => c));
  const samples = new Map<string, Sample[]>(calls.map((c) => [c.call.name, []]));
  const firstErrors: string[] = [];

  try {
    await waitReady(app);
    // A short warm-up: the first calls compile and connect.
    for (const c of calls) await c.call.run(c.token());

    console.log(`Prova: ${CONCURRENCY} client in parallelo per ${DURATION_S} s...`);
    const end = performance.now() + DURATION_S * 1000;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (performance.now() < end) {
          const c = pick(bag);
          const t0 = performance.now();
          let status = 0;
          try {
            const response = await c.call.run(c.token());
            status = response.status;
            await response.arrayBuffer();
          } catch {
            status = 0;
          }
          const ok = status >= 200 && status < 300;
          samples.get(c.call.name)!.push({ ms: performance.now() - t0, ok, status });
          if (!ok && firstErrors.length < 5) firstErrors.push(`${c.call.name}: ${status}`);
        }
      }),
    );
    const elapsed = (performance.now() - started) / 1000;

    // 3. Report.
    const rows = [...samples].map(([name, list]) => {
      const times = list.map((s) => s.ms).sort((a, b) => a - b);
      return {
        chiamata: name,
        n: list.length,
        errori: list.filter((s) => !s.ok).length,
        mediana_ms: Math.round(percentile(times, 50)),
        p95_ms: Math.round(percentile(times, 95)),
        p99_ms: Math.round(percentile(times, 99)),
        max_ms: Math.round(times.at(-1) ?? 0),
      };
    });
    console.table(rows);
    const all = [...samples.values()].flat();
    const reads = calls
      .filter((c) => c.call.read)
      .flatMap((c) => samples.get(c.call.name)!)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    const errors = all.filter((s) => !s.ok).length;
    const readP95 = percentile(reads, 95);
    console.log(
      `Richieste: ${all.length} in ${elapsed.toFixed(1)} s (${(all.length / elapsed).toFixed(1)}/s)`,
    );
    console.log(`Errori: ${errors}${firstErrors.length ? ` (es. ${firstErrors.join(', ')})` : ''}`);
    console.log(`95° percentile delle letture: ${Math.round(readP95)} ms (soglia ${P95_LIMIT} ms)`);
    const passed = errors === 0 && readP95 <= P95_LIMIT;
    console.log(passed ? 'ESITO: superata' : 'ESITO: NON superata');
    if (!passed) process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    if (stderr) console.error(`Ultimi messaggi dell'applicazione:\n${stderr}`);
    process.exitCode = 1;
  } finally {
    app.kill();
    // The organization cannot be deleted (its audit log is immutable): the data stay in the test
    // database like those of the suite, and `npm run test:db:clean -- --yes` empties it.
    console.log(
      `I dati della prova («${tenant.name}») restano nel database dei test: ` +
        '`npm run test:db:clean -- --yes` lo svuota.',
    );
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`Prova di carico non eseguita: ${err instanceof Error ? err.message : 'errore'}`);
  process.exitCode = 1;
});
