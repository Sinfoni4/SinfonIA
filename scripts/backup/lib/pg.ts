import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import pg from 'pg';

import type { ColumnInfo } from './substitution.js';

/**
 * PostgreSQL tools and catalog queries for the backup test. Connection details are passed to the
 * child processes through their own environment (never on the command line, where other
 * processes could read the password).
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

export async function tableColumns(c: pg.Client): Promise<Map<string, ColumnInfo[]>> {
  const { rows } = await c.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
  }>(
    `select table_name, column_name, data_type, udt_name
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  );
  const map = new Map<string, ColumnInfo[]>();
  for (const r of rows) {
    const list = map.get(r.table_name) ?? [];
    list.push({ name: r.column_name, dataType: r.data_type, udtName: r.udt_name });
    map.set(r.table_name, list);
  }
  return map;
}

export async function tableNames(c: pg.Client): Promise<string[]> {
  const { rows } = await c.query<{ relname: string }>(
    `select relname from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
      order by relname`,
  );
  return rows.map((r) => r.relname);
}

/** Schema elements per kind (columns, constraints, indexes, triggers, functions, extensions). */
export async function catalog(c: pg.Client): Promise<Map<string, string[]>> {
  const { rows } = await c.query<{ k: string; v: string }>(`
    select 'column' k, table_name || '.' || column_name || ':' || data_type || ':' || udt_name
           || ':' || is_nullable || ':' || coalesce(column_default, '') v
      from information_schema.columns where table_schema = 'public'
    union all
    select 'constraint', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select 'index', tablename || ':' || indexname || ':' || indexdef
      from pg_indexes where schemaname = 'public'
    union all
    select 'trigger', tgrelid::regclass::text || ':' || tgname || ':' || pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class r on r.oid = t.tgrelid
     where not tgisinternal and r.relnamespace = 'public'::regnamespace
    union all
    select 'function', p.proname || ':' || md5(pg_get_functiondef(p.oid))
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    union all
    select 'extension', extname from pg_extension`);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.k) ?? [];
    list.push(r.v);
    map.set(r.k, list);
  }
  for (const list of map.values()) list.sort();
  return map;
}

/** Rows of every single-column foreign key that point to nothing. */
export async function orphanRows(c: pg.Client): Promise<number> {
  const { rows: fks } = await c.query<{
    child: string;
    ccol: string;
    parent: string;
    pcol: string;
  }>(`
    select conrelid::regclass::text child, a.attname ccol, confrelid::regclass::text parent, b.attname pcol
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      join pg_attribute b on b.attrelid = k.confrelid and b.attnum = k.confkey[1]
     where k.contype = 'f' and k.connamespace = 'public'::regnamespace and array_length(k.conkey, 1) = 1`);
  let total = 0;
  for (const fk of fks) {
    const { rows } = await c.query<{ n: number }>(
      `select count(*)::int n from ${fk.child} c
        where c."${fk.ccol}" is not null
          and not exists (select 1 from ${fk.parent} p where p."${fk.pcol}" = c."${fk.ccol}")`,
    );
    total += rows[0]?.n ?? 0;
  }
  return total;
}

export async function writeCounters(c: pg.Client): Promise<Map<string, number>> {
  const { rows } = await c.query<{ relname: string; n: string }>(
    `select relname, (n_tup_ins + n_tup_upd + n_tup_del)::text n from pg_stat_user_tables`,
  );
  return new Map(rows.map((r) => [r.relname, Number(r.n)]));
}
