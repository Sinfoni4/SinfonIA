import type { ColumnInfo } from './substitution.js';
import type pg from 'pg';

/**
 * PostgreSQL tools and catalog queries for the backup test. The tools shared with the nightly
 * backup live in src/data/backup/pg-tools.ts (B4).
 */
export {
  client,
  connectionEnv,
  databaseName,
  pgBin,
  spawnTool,
  tableNames,
  waitFor,
} from '../../../src/data/backup/pg-tools.js';

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
