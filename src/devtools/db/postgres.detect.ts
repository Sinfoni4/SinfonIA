import { execCmd } from '../exec.js';

export async function detectPostgresEnvironment(): Promise<{
  installed: boolean;
  running: boolean;
  portListening: boolean;
}> {
  const postgresWhich = await execCmd('which postgres', 1500);
  const psqlWhich = await execCmd('which psql', 1500);
  const pgIsreadyWhich = await execCmd('which pg_isready', 1500);
  const pgCtlclusterWhich = await execCmd('which pg_ctlcluster', 1500);
  const dpkgPostgres = await execCmd('dpkg -s postgresql', 2000);
  const dockerWhich = await execCmd('which docker', 1500);

  const postgresBinaryExists = postgresWhich.code === 0 && Boolean(postgresWhich.stdout);
  const psqlExists = psqlWhich.code === 0 && Boolean(psqlWhich.stdout);
  const pgIsreadyExists = pgIsreadyWhich.code === 0 && Boolean(pgIsreadyWhich.stdout);
  const pgCtlclusterExists = pgCtlclusterWhich.code === 0 && Boolean(pgCtlclusterWhich.stdout);
  const packageInstalled = dpkgPostgres.code === 0;

  const dockerRunning =
    dockerWhich.code === 0
      ? await execCmd(`docker ps --format '{{.Image}}'`, 2500)
      : { code: 1, stdout: '', stderr: '' };

  const dockerPostgresRunning =
    dockerRunning.code === 0 ? /postgres/i.test(dockerRunning.stdout) : false;

  const ss = await execCmd('ss -ltnp', 2500);
  const portListening = /:5432\s/.test(ss.stdout);

  // If pg_isready exists, use it as best-effort "running" evidence.
  let pgIsReady = false;
  if (pgIsreadyExists) {
    const pgReady = await execCmd('pg_isready -h 127.0.0.1 -p 5432', 2500);
    pgIsReady = pgReady.code === 0;
  }

  const running = portListening || dockerPostgresRunning || pgIsReady;

  // Debian/Ubuntu often don't expose `postgres` in PATH for non-root users.
  // Treat presence of common client/server tools or installed package as "installed".
  const installed =
    postgresBinaryExists || psqlExists || pgIsreadyExists || pgCtlclusterExists || packageInstalled;

  // Requirement log: single line with these 3 values.
  console.log(
    `🔎 POSTGRES DETECT — installed: ${installed} running: ${running} port: ${portListening}`,
  );

  return {
    installed,
    running,
    portListening,
  };
}
