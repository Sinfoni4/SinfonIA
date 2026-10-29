/**
 * PostgreSQL COPY text format: one row per line, fields separated by tabs, NULL written as \N and
 * special characters escaped with a backslash. Used to read the rows of a dump as a stream.
 */

const UNESCAPE: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
};

const ESCAPE: Record<string, string> = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\\': '\\\\',
};

export function unescapeCopyField(field: string): string {
  return field.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_m, seq: string) => {
    if (seq.length > 1 && seq[0] === 'x') return String.fromCharCode(parseInt(seq.slice(1), 16));
    if (/^[0-7]+$/.test(seq)) return String.fromCharCode(parseInt(seq, 8));
    return UNESCAPE[seq] ?? seq;
  });
}

export function escapeCopyField(value: string): string {
  return value.replace(/[\b\f\n\r\t\v\\]/g, (c) => ESCAPE[c] ?? c);
}

export function splitCopyLine(line: string): Array<string | null> {
  return line.split('\t').map((field) => (field === '\\N' ? null : unescapeCopyField(field)));
}

export function joinCopyLine(fields: Array<string | null>): string {
  return fields.map((f) => (f === null ? '\\N' : escapeCopyField(f))).join('\t');
}

/** Elements of a one-dimensional PostgreSQL text array literal, e.g. {a,"b c",NULL}. */
export function parseTextArray(literal: string): Array<string | null> {
  if (!literal.startsWith('{') || !literal.endsWith('}')) {
    throw new Error('Not a one-dimensional array literal');
  }
  const body = literal.slice(1, -1);
  const out: Array<string | null> = [];
  if (body.length === 0) return out;
  let i = 0;
  while (i <= body.length) {
    if (body[i] === '"') {
      let value = '';
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i++;
        value += body[i];
        i++;
      }
      out.push(value);
      i += 2; // closing quote and comma
    } else {
      const end = body.indexOf(',', i);
      const raw = end === -1 ? body.slice(i) : body.slice(i, end);
      out.push(raw === 'NULL' ? null : raw);
      i = end === -1 ? body.length + 1 : end + 1;
    }
  }
  return out;
}

export function formatTextArray(values: Array<string | null>): string {
  return `{${values
    .map((v) => (v === null ? 'NULL' : `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`))
    .join(',')}}`;
}
