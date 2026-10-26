export function analyzeDatabaseUrl(): {
  ok: boolean;
  host?: string;
  port?: string;
  database?: string;
  sslMode?: string;
  poolParams: Record<string, string>;
} {
  console.log('🧪 DATABASE URL ANALYSIS');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('🔴 DATABASE_URL missing');
    return { ok: false, poolParams: {} };
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    console.log('🔴 DATABASE_URL invalid');
    return { ok: false, poolParams: {} };
  }

  const host = url.hostname;
  const port = url.port || '5432';
  // url.pathname starts with "/<db>"
  const database = url.pathname?.replace(/^\//, '') || '';

  // Common SSL indicators:
  // - ?sslmode=disable|require|prefer
  // - ?ssl=true/false
  const sslModeFromQuery =
    url.searchParams.get('sslmode') ||
    url.searchParams.get('ssl') ||
    url.searchParams.get('sslm') ||
    null;

  const sslModeNormalized =
    sslModeFromQuery === null ? 'n/a' : String(sslModeFromQuery).toLowerCase();

  // Heuristic:
  // - sslmode=disable => ssl=false
  // - sslmode=require => ssl=true
  // - ssl=true => ssl=true
  // - otherwise => ssl=unknown
  const sslMode =
    sslModeNormalized === 'disable' || sslModeNormalized === 'false'
      ? 'ssl=false'
      : sslModeNormalized === 'require' || sslModeNormalized === 'true'
        ? 'ssl=true'
        : `ssl=${sslModeNormalized}`;

  // Pool-ish params: just print known URL query keys if present (no secrets).
  const candidateKeys = [
    'connection_limit',
    'pool_size',
    'max_pool_size',
    'min_pool_size',
    'idleTimeoutMillis',
    'statement_timeout',
    'tcp_keepalives_idle',
    'tcp_keepalives_interval',
    'tcp_keepalives_count',
    'application_name',
  ];

  const poolParams: Record<string, string> = {};
  for (const k of candidateKeys) {
    const v = url.searchParams.get(k);
    if (v !== null) poolParams[k] = v;
  }

  console.log(`host=${host}`);
  console.log(`port=${port}`);
  console.log(`db=${database || 'n/a'}`);
  console.log(`ssl mode=${sslMode}`);
  console.log(`pool params=${Object.keys(poolParams).length ? JSON.stringify(poolParams) : 'n/a'}`);

  const ok = Boolean(host && port && database);
  return { ok, host, port, database, sslMode, poolParams };
}
