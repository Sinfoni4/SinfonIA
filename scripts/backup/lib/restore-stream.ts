import { Transform } from 'node:stream';

import { joinCopyLine, splitCopyLine } from './copy-text.js';

import type { RowDigests, ValueSet } from './digests.js';
import type { ColumnInfo, Substitution } from './substitution.js';

/**
 * Line-by-line transform of the SQL script produced by `pg_restore -f -`.
 * Schema statements pass unchanged; the rows of each `COPY ... FROM stdin` block are
 * fingerprinted as they are in the dump (before anything changes) and then substituted.
 * Original values exist only in memory, one row at a time.
 */

const COPY_HEADER = /^COPY (?:public\.)?(?:"([^"]+)"|([A-Za-z_][\w]*)) \(([^)]*)\) FROM stdin;$/;

export type RestoreStreamOptions = {
  /** Columns of every table, read from the source catalog. */
  columns: Map<string, ColumnInfo[]>;
  substitution: Substitution;
  /** Fingerprints of the rows as they are in the dump. */
  dumpDigests: RowDigests;
  /** Original values of the substituted fields, to prove none reaches the copy. */
  originals: ValueSet;
  /** Values of substituted columns left identical by the rules, counted per column. */
  unchangedByRule?: Map<string, number>;
};

export function parseCopyHeader(line: string): { table: string; columns: string[] } | null {
  const m = COPY_HEADER.exec(line);
  if (!m) return null;
  const columns = (m[3] ?? '')
    .split(',')
    .map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  return { table: m[1] ?? m[2] ?? '', columns };
}

export function createRestoreTransform(options: RestoreStreamOptions): Transform {
  let pending = '';
  let block: { table: string; columns: ColumnInfo[] } | null = null;

  // pg_restore on Windows ends lines with CRLF: a raw CR is never part of COPY data (it is
  // escaped as \r), so it is a line terminator.
  const processLine = (rawLine: string): string => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (block) {
      if (line === '\\.') {
        block = null;
        return line;
      }
      options.dumpDigests.add(block.table, line);
      const fields = splitCopyLine(line);
      const { table, columns } = block;
      return joinCopyLine(
        fields.map((value, i) => {
          const column = columns[i];
          if (!column) throw new Error(`Unexpected field ${i} in table ${table}`);
          const out = options.substitution.value(table, column, value);
          if (value !== null && !options.substitution.keeps(table, column)) {
            // JSON is compared by content: PostgreSQL normalizes its text again on restore.
            const isJson = column.dataType === 'jsonb' || column.dataType === 'json';
            const same = isJson
              ? out !== null &&
                JSON.stringify(JSON.parse(value)) === JSON.stringify(JSON.parse(out))
              : out === value;
            if (!same) options.originals.add(value);
            else {
              // Nothing to replace under the rules (e.g. JSON with only enumerations and numbers).
              const key = `${table}.${column.name}`;
              options.unchangedByRule?.set(key, (options.unchangedByRule.get(key) ?? 0) + 1);
            }
          }
          return out;
        }),
      );
    }
    const header = parseCopyHeader(line);
    if (header) {
      const known = options.columns.get(header.table);
      if (!known) throw new Error(`Table ${header.table} is not in the source catalog`);
      const columns = header.columns.map((name) => {
        const column = known.find((c) => c.name === name);
        if (!column) throw new Error(`Column ${header.table}.${name} is not in the source catalog`);
        return column;
      });
      block = { table: header.table, columns };
      options.dumpDigests.touch(header.table);
    }
    return line;
  };

  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      try {
        done(null, lines.map((l) => `${processLine(l)}\n`).join(''));
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done) {
      try {
        const last = pending ? processLine(pending) : '';
        // A stream that ends inside a data block is truncated: never restore it silently.
        if (block) throw new Error(`Dump ended inside the data of table ${block.table}`);
        done(null, last);
      } catch (err) {
        done(err as Error);
      }
    },
  });
}
