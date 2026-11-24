import { tableFileFromRows, tableFileName, type TableFile } from '../../shared/table-file.js';

import type { SectorRecordView } from './sector-records.service.js';
import type { SectorRecordKind } from '../../modules/registry.js';
import type { FieldDefinition } from '../modules/module.contract.js';

/**
 * The register of a sector function as a file. CSV and Excel carry every declared field, one
 * column each (a field shared by several kinds of entry, like «Appezzamento», is one column);
 * the PDF keeps the main columns and puts the other fields in «Dettagli», so it reads on A4 for
 * a check.
 */

export type RegisterExportFormat = 'csv' | 'xlsx' | 'pdf';

const italianDate = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '');

function valueText(field: FieldDefinition, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'choice') {
    return (
      field.options?.find((o) => o.value === value)?.label ??
      (typeof value === 'string' ? value : JSON.stringify(value))
    );
  }
  if (field.type === 'date' && typeof value === 'string') return italianDate(value);
  if (field.type === 'number' && typeof value === 'number') {
    return value.toLocaleString('it-IT', { maximumFractionDigits: 6 });
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A spreadsheet must never read a value as a formula: a text starting with =, +, -, @ or a
 * control character gets a leading apostrophe (OWASP CSV injection).
 */
function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvText(rows: string[][]): string {
  const line = (row: string[]) =>
    row.map((cell) => `"${safeCell(cell).replace(/"/g, '""')}"`).join(';');
  // BOM and semicolons: Excel in Italian opens it with accents and columns right.
  return `\uFEFF${rows.map(line).join('\r\n')}\r\n`;
}

/** The fields that get a column: every declared field once, but not the date of the entry. */
function columnsOf(kinds: readonly SectorRecordKind[]): FieldDefinition[] {
  const seen = new Map<string, FieldDefinition>();
  for (const kind of kinds) {
    for (const field of kind.fields) {
      if (field.key === kind.dateField || seen.has(field.key)) continue;
      seen.set(field.key, field);
    }
  }
  return [...seen.values()];
}

/**
 * The «Dettagli» of an entry in the PDF: the fields not already in the other columns, as
 * «Label: value», an amount with its unit («Quantità: 30 tonnellate»).
 */
export function entryDetails(
  kind: SectorRecordKind | undefined,
  data: Record<string, unknown>,
): string {
  if (!kind) return '';
  const units = kind.units ?? {};
  const unitFields = new Set(Object.values(units));
  return kind.fields
    .filter(
      (f) =>
        f.key !== kind.dateField &&
        f.key !== kind.dueField &&
        !kind.titleFields.includes(f.key) &&
        // A unit is written after its amount, never on its own.
        !unitFields.has(f.key),
    )
    .map((f) => {
      const text = valueText(f, data[f.key]);
      const unitField = units[f.key] ? kind.fields.find((u) => u.key === units[f.key]) : undefined;
      const unit = unitField ? valueText(unitField, data[unitField.key]) : '';
      return [f.label, text && unit ? `${text} ${unit}` : text] as const;
    })
    .filter(([, v]) => v !== '')
    .map(([label, v]) => `${label}: ${v}`)
    .join(' · ');
}

export async function registerTable(input: {
  label: string;
  kinds: readonly SectorRecordKind[];
  records: readonly SectorRecordView[];
  format: RegisterExportFormat;
  today: string;
}): Promise<TableFile> {
  const title = `${input.label} al ${italianDate(input.today)}`;
  const kindOf = new Map(input.kinds.map((k) => [k.kind, k]));
  const hasExpiry = input.kinds.some((k) => k.dueField);
  const hasNotify = input.kinds.some((k) => k.notify);

  if (input.format === 'pdf') {
    const rows = [
      ['Data', 'Tipo', 'Voce', 'Dettagli', ...(hasExpiry ? ['Scadenza'] : [])],
      ...input.records.map((r) => {
        const details = entryDetails(kindOf.get(r.kind), r.data);
        return [
          italianDate(r.occurredOn),
          r.kindLabel,
          r.title,
          details,
          ...(hasExpiry ? [italianDate(r.dueDate)] : []),
        ];
      }),
    ];
    return tableFileFromRows({ title, rows, format: 'pdf' });
  }

  const columns = columnsOf(input.kinds);
  const rows = [
    [
      'Data',
      'Tipo',
      'Voce',
      ...columns.map((c) => c.label),
      ...(hasExpiry ? ['Scadenza'] : []),
      ...(hasNotify ? ['Persona da avvisare'] : []),
      'File allegati',
      'Inserita da',
      'Inserita il',
    ],
    ...input.records.map((r) => [
      italianDate(r.occurredOn),
      r.kindLabel,
      r.title,
      ...columns.map((c) => {
        const own = kindOf.get(r.kind)?.fields.find((f) => f.key === c.key);
        return own ? valueText(own, r.data[c.key]) : '';
      }),
      ...(hasExpiry ? [italianDate(r.dueDate)] : []),
      ...(hasNotify ? [r.notify?.label ?? ''] : []),
      String(r.attachments.length),
      r.author?.email ?? '',
      italianDate(r.createdAt.slice(0, 10)),
    ]),
  ];
  if (input.format === 'xlsx') return tableFileFromRows({ title, rows, format: 'xlsx' });
  return {
    fileName: tableFileName(title, 'xlsx').replace(/\.xlsx$/, '.csv'),
    mimeType: 'text/csv; charset=utf-8',
    content: Buffer.from(csvText(rows), 'utf8'),
  };
}
