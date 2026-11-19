/**
 * Starts the local staging in one command, e.g. after a reboot of the PC:
 *
 * 1. the PostgreSQL cluster of staging and tests (.runtime/pgdata_test, port 5433) if it is down;
 * 2. a check that the staging port is free (a process already there is reported, never stopped);
 * 3. the dashboard built from the current code (web/dist), so it never lags behind the backend
 *    (FE5); `--no-build` keeps the existing build;
 * 4. the application with the least-privilege role (sinfonia_staging_app) and the staging
 *    attachment folder, in the foreground: Ctrl+C stops it.
 *
 * Host and port come from DATABASE_URL in .env.test, the password from DB_APP_PASSWORD in .env;
 * the connection string is never printed. `--check` only checks and reports.
 *
 * `--dashboard-login`: the dashboard login with the code shown on screen, while emails are
 * simulated (no provider yet, D11). The server then answers on this PC only (127.0.0.1): anyone
 * who reached the page could log in as anyone invited.
 *
 * `--public --public-url=https://…`: staging reachable from the Internet through a tunnel (the
 * Telegram Mini App needs HTTPS). Only the Mini App login (data signed by Telegram, linked
 * accounts): no email login, no code on screen, no signed preview. The server still answers on
 * 127.0.0.1 only: the tunnel reaches it from this PC. Not together with `--dashboard-login`.
 * `--demo`: the generic demo link `t.me/<bot>?start=demo` (DEMO_ACCESS): an account of one's own
 * in «SinfonIA Demo» with invented data, deleted after a week; never a real organization.
 * Usage: npm run staging:start [-- --check] [-- --dashboard-login] [-- --no-build]
 *        npm run staging:start -- --public --public-url=https://<address> [--demo]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { checkPublicUrl } from './public-url.js';

const PG_BIN = process.env.MF0_PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const DATA_DIR = '.runtime/pgdata_test';
const DATABASE = 'sinfonia_staging';
const APP_ROLE = 'sinfonia_staging_app';
const STORAGE_DIR = path.resolve('.runtime/storage-staging');
const WEB_DIST = path.resolve('web/dist');
const PORT = Number(process.env.STAGING_PORT ?? 3110);
const checkOnly = process.argv.includes('--check');
const dashboardLogin = process.argv.includes('--dashboard-login');
const skipBuild = process.argv.includes('--no-build');
const publicMode = process.argv.includes('--public');
const demoMode = process.argv.includes('--demo');
const publicUrl = process.argv
  .find((a) => a.startsWith('--public-url='))
  ?.slice('--public-url='.length)
  .replace(/\/+$/, '');

function envValue(file: string, key: string): string {
  if (!existsSync(file)) throw new Error(`${file} not found (run from the repository folder)`);
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing in ${file}`);
  return line.slice(key.length + 1).replace(/^"|"$/g, '');
}

function tool(name: string): string {
  return path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name);
}

function databaseReady(host: string, port: string): boolean {
  return spawnSync(tool('pg_isready'), ['-h', host, '-p', port], { stdio: 'ignore' }).status === 0;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

async function main() {
  const testUrl = new URL(envValue('.env.test', 'DATABASE_URL'));
  const host = testUrl.hostname;
  const dbPort = testUrl.port || '5432';

  // 1. Database cluster.
  if (databaseReady(host, dbPort)) {
    console.log(`Database: attivo sulla porta ${dbPort}`);
  } else if (checkOnly) {
    console.log(`Database: NON attivo sulla porta ${dbPort} (lo script lo avvierebbe)`);
  } else {
    if (!existsSync(DATA_DIR)) throw new Error(`Cluster folder ${DATA_DIR} not found`);
    console.log(`Database: avvio del cluster ${DATA_DIR} sulla porta ${dbPort}...`);
    // Detached, in its own process group: stopping the application (Ctrl+C, closing the
    // terminal) must not stop the database, which the test suite uses too.
    spawn(
      tool('pg_ctl'),
      ['-D', DATA_DIR, '-o', `-p ${dbPort}`, '-l', `${DATA_DIR}/postgres.log`, 'start'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();
    const deadline = Date.now() + 60_000;
    while (!databaseReady(host, dbPort)) {
      if (Date.now() > deadline) {
        throw new Error(`The cluster did not start: see ${DATA_DIR}/postgres.log`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log('Database: avviato (resta attivo anche quando si ferma lo staging)');
  }

  // 2. Port of the application: never take it from another process.
  if (!(await portFree(PORT))) {
    console.log(
      `Porta ${PORT}: già occupata. Lo staging è forse già avviato: controlla ` +
        `http://localhost:${PORT}/readyz. Nessun processo è stato fermato.`,
    );
    process.exitCode = checkOnly ? 0 : 1;
    return;
  }
  console.log(`Porta ${PORT}: libera`);

  // Application settings: least-privilege role and its own attachment folder.
  const appUrl = new URL(testUrl);
  appUrl.pathname = `/${DATABASE}`;
  appUrl.username = APP_ROLE;
  appUrl.password = encodeURIComponent(envValue('.env', 'DB_APP_PASSWORD'));
  if (!existsSync(STORAGE_DIR)) {
    throw new Error(`Staging attachment folder ${STORAGE_DIR} not found`);
  }
  if (checkOnly) {
    console.log(`Applicazione: pronta per l'avvio con ${APP_ROLE} e allegati in ${STORAGE_DIR}`);
    return;
  }
  // 3. The dashboard from the current code: a merge that changes it is never served stale.
  if (!skipBuild) {
    console.log('Dashboard: compilazione...');
    const build = spawnSync(process.execPath, ['--run', 'web:build'], { stdio: 'inherit' });
    if (build.status !== 0 || !existsSync(path.join(WEB_DIST, 'index.html'))) {
      throw new Error('Dashboard build failed (npm run web:build)');
    }
  }

  // 4. The application.
  if (publicMode && dashboardLogin) {
    throw new Error(
      '--public e --dashboard-login non vanno insieme: il codice a schermo resta locale',
    );
  }
  const origin = publicMode ? checkPublicUrl(publicUrl) : null;
  console.log(`Applicazione: avvio sulla porta ${PORT} con ${APP_ROLE} (Ctrl+C per fermarla)`);
  if (origin) {
    console.log(`Mini App: ${origin}/app/tg (solo account Telegram collegati; nessun login email)`);
  }
  if (dashboardLogin) {
    console.log(
      `Dashboard: http://localhost:${PORT}/app/ con il codice sullo schermo, solo da questo PC`,
    );
  }
  const app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: appUrl.toString(),
      STORAGE_LOCAL_DIR: STORAGE_DIR,
      // The dashboard, when built (npm run web:build), is served under /app.
      ...(existsSync(WEB_DIST) ? { WEB_DIST_DIR: WEB_DIST } : {}),
      PORT: String(PORT),
      SCHEDULER_INTERVAL_MS: process.env.SCHEDULER_INTERVAL_MS ?? '15000',
      OUTBOX_DISPATCH_INTERVAL_MS: process.env.OUTBOX_DISPATCH_INTERVAL_MS ?? '3000',
      ...(demoMode ? { DEMO_ACCESS: 'true' } : {}),
      ...(origin
        ? {
            TELEGRAM_MINIAPP: 'true',
            AUTH_EMAIL_LOGIN: 'false',
            AUTH_DEV_SHOW_CODE: 'false',
            WEB_PUBLIC_URL: origin,
            HOST: '127.0.0.1',
          }
        : {}),
      ...(dashboardLogin
        ? {
            AUTH_EMAIL_LOGIN: 'true',
            AUTH_DEV_SHOW_CODE: 'true',
            WEB_PUBLIC_URL: `http://localhost:${PORT}`,
            HOST: '127.0.0.1',
          }
        : {}),
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.kill(signal));
  }
  app.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}

main().catch((err: unknown) => {
  console.error(
    `Staging non avviato: ${err instanceof Error ? err.message : 'errore sconosciuto'}`,
  );
  process.exitCode = 1;
});
