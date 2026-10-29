import { randomBytes, randomInt } from 'node:crypto';

import { formatTextArray, parseTextArray } from './copy-text.js';

/**
 * Replaces the values of a database copy with random ones, consistently for the whole run:
 * identifiers are remapped (relations and unique constraints stay valid), dates are shifted by the
 * same number of days, free text and contact data become random values of the same format.
 * Only an explicit list of technical columns and JSON keys is kept; everything else is replaced,
 * including columns and keys added in the future. The maps live only in memory.
 * See docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §10.6.
 */

export type ColumnInfo = { name: string; dataType: string; udtName: string };

/** Tables copied unchanged: no personal data (migration history). */
export const KEEP_TABLES = new Set(['_prisma_migrations']);

/** Text columns kept as they are: technical values, never personal. */
export const KEEP_TEXT_COLUMNS = new Set([
  'ai_trace.request_id',
  'ai_trace.model',
  'ai_trace.provider',
  'ai_trace.outcome',
  'ai_trace.action',
  'audit_log.event_type',
  'outbox_message.event_type',
  'practice_attachment.mime_type',
  'scheduler_job.task_type',
  'scheduler_job.frequency',
  'tenant.module',
  'tenant.integration_type',
  'tenant.scheduler_frequency',
]);

type TextFormat = 'email' | 'telegram' | 'phone' | 'url' | 'token';

const COLUMN_FORMATS: Record<string, TextFormat> = {
  'user.email': 'email',
  'user.telegram_id': 'telegram',
  'whatsapp_identity.phone_number': 'phone',
  'tenant.webhook_url': 'url',
};

/** JSON keys kept by name (schema of the payloads); unknown keys are renamed. */
export const KEEP_JSON_KEYS = new Set([
  'schemaVersion',
  'type',
  'name',
  'kind',
  'metadata',
  'category',
  'dueDate',
  'title',
  'code',
  'deadlineId',
  'practiceId',
  'tenantId',
  'userId',
  'from',
  'to',
  'nextState',
  'previousState',
  'status',
  'filter',
  'value',
  'count',
  'thresholdDays',
  'chatId',
  'documentType',
  'confidence',
  'currency',
  'total',
  'totalAmount',
  'taxableAmount',
  'vatAmount',
  'vatRate',
  'items',
  'quantity',
  'unitPrice',
  'unitOfMeasure',
  'itemCode',
  'description',
  'documentDate',
  'documentNumber',
  'issueDate',
  'expiryDate',
  'pages',
  'source',
  'warnings',
  'missingFields',
  'reviewRequired',
  'detectedKeywords',
  'extraction',
  'extractedText',
  'supplierName',
  'supplierVat',
  'merchantName',
  'merchantVat',
  'recipientName',
  'holderName',
  'issuer',
  'carrierName',
  'certificateNumber',
  'destinationAddress',
  'tasks',
  'frequency',
  'enabled',
]);

/** JSON keys whose string values are enumerations: kept. */
export const KEEP_JSON_VALUES = new Set([
  'schemaVersion',
  'type',
  'kind',
  'category',
  'status',
  'nextState',
  'previousState',
  'documentType',
  'currency',
  'source',
  'frequency',
  'unitOfMeasure',
]);

/** JSON keys whose numbers identify people or chats: replaced. */
const ID_NUMBER_KEYS = new Set(['chatId', 'telegramId', 'phone', 'phoneNumber']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(.*)$/s;
const KEEP_TYPES = new Set([
  'boolean',
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'real',
  'double precision',
  'USER-DEFINED',
]);
const DATE_TYPES = new Set(['date', 'timestamp with time zone', 'timestamp without time zone']);
const TEXT_TYPES = new Set(['text', 'character varying', 'character']);

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const digits = (n: number) =>
  String(randomInt(1, 10)) + Array.from({ length: n - 1 }, () => randomInt(0, 10)).join('');

export class Substitution {
  readonly shiftDays: number;
  private readonly uuids = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly used = new Set<string>();
  /** Columns that were not classified and have been replaced by default. */
  readonly unclassified = new Set<string>();

  constructor(shiftDays?: number) {
    // Whole days, so date and timestamp columns keep order and intervals.
    this.shiftDays = shiftDays ?? (randomInt(0, 2) ? 1 : -1) * randomInt(30, 400);
  }

  private fresh(make: () => string): string {
    for (;;) {
      const candidate = make();
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }

  uuid(value: string): string {
    const key = value.toLowerCase();
    let mapped = this.uuids.get(key);
    if (!mapped) {
      mapped = this.fresh(() => {
        const h = hex(16);
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      });
      this.uuids.set(key, mapped);
    }
    return mapped;
  }

  text(value: string, format: TextFormat = 'token'): string {
    if (UUID.test(value)) return this.uuid(value);
    const key = `${format}\u0000${value}`;
    let mapped = this.texts.get(key);
    if (!mapped) {
      const make: Record<TextFormat, () => string> = {
        email: () => `u${hex(5)}@example.invalid`,
        telegram: () => digits(10),
        phone: () => `39${digits(10)}`,
        url: () => `https://example.invalid/${hex(5)}`,
        token: () => `anon_${hex(5)}`,
      };
      mapped = this.fresh(make[format]);
      this.texts.set(key, mapped);
    }
    return mapped;
  }

  /** Shifts the date at the start of a value ("2026-10-28", "2026-10-28 10:00:00+00", ISO). */
  shiftDate(value: string): string {
    const m = DATE_PREFIX.exec(value);
    if (!m) return this.text(value);
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    d.setUTCDate(d.getUTCDate() + this.shiftDays);
    return d.toISOString().slice(0, 10) + m[4];
  }

  private jsonKey(key: string): string {
    if (KEEP_JSON_KEYS.has(key)) return key;
    let mapped = this.keys.get(key);
    if (!mapped) {
      mapped = this.fresh(() => `k_${hex(4)}`);
      this.keys.set(key, mapped);
    }
    return mapped;
  }

  json(node: unknown, key?: string): unknown {
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      return key && ID_NUMBER_KEYS.has(key) ? Number(this.text(String(node), 'telegram')) : node;
    }
    if (typeof node === 'string') {
      if (UUID.test(node)) return this.uuid(node);
      if (
        DATE_PREFIX.test(node) &&
        /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?$/.test(node)
      ) {
        return this.shiftDate(node);
      }
      if (key && KEEP_JSON_VALUES.has(key)) return node;
      return this.text(node);
    }
    if (Array.isArray(node)) return node.map((item) => this.json(item, key));
    if (typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [
          this.jsonKey(k),
          this.json(v, k),
        ]),
      );
    }
    return this.text(String(node));
  }

  /** True when the value of this column is written to the copy unchanged. */
  keeps(table: string, column: ColumnInfo): boolean {
    if (KEEP_TABLES.has(table)) return true;
    if (column.udtName === 'uuid' || DATE_TYPES.has(column.dataType)) return false;
    if (KEEP_TYPES.has(column.dataType)) return true;
    return KEEP_TEXT_COLUMNS.has(`${table}.${column.name}`);
  }

  /** Substitute value for one field (already unescaped; null stays null). */
  value(table: string, column: ColumnInfo, value: string | null): string | null {
    if (value === null || this.keeps(table, column)) return value;
    const id = `${table}.${column.name}`;
    if (column.udtName === 'uuid') return this.uuid(value);
    if (DATE_TYPES.has(column.dataType)) return this.shiftDate(value);
    if (column.dataType === 'jsonb' || column.dataType === 'json') {
      return JSON.stringify(this.json(JSON.parse(value)));
    }
    if (column.dataType === 'ARRAY') {
      return formatTextArray(parseTextArray(value).map((v) => (v === null ? null : this.text(v))));
    }
    if (!TEXT_TYPES.has(column.dataType)) this.unclassified.add(id);
    return this.text(value, COLUMN_FORMATS[id] ?? 'token');
  }
}
