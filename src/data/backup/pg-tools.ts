import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import pg from 'pg';

/**
 * PostgreSQL tools for the encrypted backups (B4: also run by the application at night).
 * Connection details are passed to the child processes through their own environment (never on
 * the command line, where other processes could read the password).
 */

export function pgBin(tool: string): string {
  const dir = process.env.MF0_PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
  return path.join(dir, process.platform === 'win32' ? `${tool}.exe` : tool);
}

export function connectionEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
    PGAPPNAME: 'sinfonia-mf0',
    // Same text format for dates in pg_dump and in the verification reads.
    PGOPTIONS: '-c TimeZone=UTC',
  };
}

export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

export function spawnTool(tool: string, args: string[], url: string): ChildProcess {
  // Temporary files of the tools go to a dedicated folder, checked empty at the end (V10).
  const tmp = process.env.MF0_TOOL_TMP;
  const env = {
    ...process.env,
    ...connectionEnv(url),
    ...(tmp ? { TMP: tmp, TEMP: tmp, TMPDIR: tmp } : {}),
  };
  return spawn(pgBin(tool), args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/** Resolves when the process exits with code 0; stderr is returned only as a line count. */
export function waitFor(child: ChildProcess, name: string): Promise<void> {
  let stderrLines = 0;
  let firstError = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrLines += text.split('\n').filter(Boolean).length;
    // Only the error class is kept: messages of psql can quote a row of the copy.
    if (!firstError) firstError = (/(ERROR|FATAL|error):?\s+[^:\n]{0,80}/.exec(text) ?? [''])[0];
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${name} exited with ${code} (${stderrLines} stderr lines; ${firstError})`),
        );
    });
  });
}

export function client(url: string): pg.Client {
  return new pg.Client({
    connectionString: url,
    application_name: 'sinfonia-mf0',
    options: '-c TimeZone=UTC',
  });
}

export async function tableNames(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ relname: string }>(
    `select relname from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
      order by relname`,
  );
  return rows.map((r) => r.relname);
}
