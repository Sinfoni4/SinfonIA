import { createHash } from 'node:crypto';

import { detectFileKind } from '../../ai/ocr/text-extraction.js';
import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import {
  deadlineCategoriesOf,
  getModule,
  isSectorFeature,
  sectorFeature,
  sectorFeatureApplies,
  sectorRecordKind,
  type SectorChannel,
  type SectorFeature,
  type SectorFeatureDefinition,
  type SectorRecordKind,
} from '../../modules/registry.js';
import { authorize, type Grant, type Principal } from '../authz/authorization.service.js';
import { daysUntil, parseIsoDate, toIsoDate, todayInRome } from '../compliance/compliance.dates.js';
import { FeatureDisabledError, featureEnabled } from '../features/features.js';
import { fieldListSchema } from '../modules/module.contract.js';

import { registerTable, type RegisterExportFormat } from './sector-records.export.js';

import type { StorageService } from '../../data/storage/storage.service.js';
import type { PrismaTx } from '../../data/types/prisma.js';
import type { TableFile } from '../../shared/table-file.js';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The register of a function of a sector (Quaderno di campagna, Abilitazioni e patentini, ...):
 * entries with the fields the function declares (src/modules/sector-records.ts).
 *
 * Every call checks, in this order: the function exists for the organization's sector, it is on
 * for the channel the request comes from (dashboard or Mini App, chosen apart from the console),
 * it is built, and the person has its own permission (`<function>.read` / `<function>.manage`,
 * custom roles included). Staff work on the whole register, members only on their entries.
 *
 * An entry with an expiry (e.g. a licence) keeps one deadline of the organization in step, so the
 * usual reminders (30, 15, 7, 1 days and the day itself) work without anything new.
 *
 * Fase 1A: an entry is never overwritten nor deleted. Every change is a correction with its reason
 * and a new version kept in `sector_record_version`; an entry is voided, with its reason, and
 * stays in the register (out of the lists unless asked for) with its files and its history.
 */

export class SectorRecordError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 = 400,
    readonly code = 'SECTOR_RECORD_INVALID',
  ) {
    super(message);
    this.name = 'SectorRecordError';
  }
}

export type SectorRecordView = {
  id: string;
  feature: string;
  kind: string;
  kindLabel: string;
  title: string;
  data: Record<string, unknown>;
  occurredOn: string | null;
  dueDate: string | null;
  /** Days to the expiry (negative: past); null without one. */
  daysLeft: number | null;
  author: { id: string; email: string } | null;
  /** The person of the organization the expiry is reminded to (kinds that declare `notify`). */
  notify: SectorPerson | null;
  mine: boolean;
  attachments: SectorAttachmentView[];
  /** The number of the current version (1 when written, +1 at every correction or voiding). */
  version: number;
  /** When, why and by whom the entry was voided; null for an entry in force. */
  voided: { at: string; reason: string; by: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

/** One version of an entry, as kept in its history. */
export type SectorRecordVersionView = {
  version: number;
  action: 'CREATED' | 'CORRECTED' | 'VOIDED';
  title: string;
  data: Record<string, unknown>;
  occurredOn: string | null;
  dueDate: string | null;
  reason: string | null;
  channel: string | null;
  author: string | null;
  changedAt: string;
};

export type SectorAttachmentView = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
};

/** A person of the organization, as shown in a register (email, or a chat-only account). */
export type SectorPerson = { id: string; label: string };

export type SectorRegisterPage = {
  feature: { id: string; label: string; description: string };
  kinds: readonly SectorRecordKind[];
  canManage: boolean;
  /** Whether the caller may void entries (through a delegation: only with its DELETE operation). */
  canVoid: boolean;
  /**
   * Who the writer may name as the person to remind: the active people of the organization for
   * staff, only themselves for a member; empty when no kind of entry names one.
   */
  people: SectorPerson[];
  items: SectorRecordView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type Access = {
  grant: Grant;
  definition: SectorFeatureDefinition & { records: readonly SectorRecordKind[] };
  module: ReturnType<typeof getModule>;
};

const MAX_TITLE = 300;
const REASON_MIN = 3;
const REASON_MAX = 500;
const DEADLINE_TITLE_MAX = 200;
const SEARCH_MAX = 100;

/**
 * Whether the person may use the function on this channel, and with which scope. Throws
 * SectorRecordError (unknown, off or not built) or PermissionDeniedError (role).
 */
export async function authorizeSector(
  prisma: Pick<PrismaClient, 'tenant'>,
  principal: Principal,
  feature: string,
  operation: 'read' | 'manage',
  channel: SectorChannel,
): Promise<Access> {
  const definition = isSectorFeature(feature) ? sectorFeature(feature) : undefined;
  const tenant = await prisma.tenant.findUnique({
    where: { id: principal.tenantId },
    select: { module: true, enabledFeatures: true, miniAppFeatures: true },
  });
  if (!definition || !tenant || !sectorFeatureApplies(feature, tenant.module)) {
    throw new SectorRecordError(
      'Funzione non disponibile per questa organizzazione',
      404,
      'NOT_FOUND',
    );
  }
  const on = channel === 'miniapp' ? tenant.miniAppFeatures : tenant.enabledFeatures;
  if (!on.includes(feature)) {
    throw new SectorRecordError(
      channel === 'miniapp'
        ? `«${definition.label}» non è attiva nella Mini App`
        : `«${definition.label}» non è attiva nella dashboard`,
      403,
      'SECTOR_FEATURE_OFF',
    );
  }
  if (!definition.ready || !definition.records?.length) {
    throw new SectorRecordError(
      `«${definition.label}» è in preparazione`,
      409,
      'SECTOR_FEATURE_NOT_READY',
    );
  }
  const permission = `${feature as SectorFeature}.${operation}` as const;
  // Through a delegation the route already checked the operation and the register (MF8): the
  // whole register of the grantor, as for its staff.
  const grant: Grant = principal.delegation
    ? { principal, permission, scope: 'tenant' }
    : authorize(principal, permission);
  return {
    grant,
    definition: { ...definition, records: definition.records },
    module: getModule(tenant.module),
  };
}

function choiceLabel(kind: SectorRecordKind, key: string, value: unknown): string {
  const field = kind.fields.find((f) => f.key === key);
  if (field?.type === 'choice') {
    return field.options?.find((o) => o.value === value)?.label ?? String(value);
  }
  return String(value);
}

/** The title of an entry from its declared title fields, or the label of its kind. */
export function recordTitle(kind: SectorRecordKind, data: Record<string, unknown>): string {
  const parts = kind.titleFields
    .filter((key) => data[key] !== undefined && data[key] !== null && data[key] !== '')
    .map((key) => choiceLabel(kind, key, data[key]));
  const title = parts.length > 0 ? parts.join(' · ') : kind.label;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

function dateOf(data: Record<string, unknown>, key: string | undefined): Date | null {
  if (!key || typeof data[key] !== 'string') return null;
  return parseIsoDate(data[key]);
}

/** The title of the deadline of an entry: its kind of entry, then its title. */
export function deadlineTitle(kind: SectorRecordKind, title: string): string {
  return `${kind.label}: ${title}`;
}

/** The key of the person to remind in the data of an entry, apart from the declared fields. */
const NOTIFY_KEY = 'notify';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a person shows in a register: the email, or a chat-only account (no email of its own). */
export function personLabel(user: { id: string; email: string }): string {
  return user.email.endsWith('@local.invalid')
    ? `Account solo chat (…${user.id.slice(-4)})`
    : user.email;
}

/** The person to remind, taken out of the data: only for kinds that declare it, as an id. */
function splitNotify(
  kind: SectorRecordKind,
  data: unknown,
): { fields: unknown; notify: string | null } {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !(NOTIFY_KEY in data)) {
    return { fields: data, notify: null };
  }
  const { [NOTIFY_KEY]: raw, ...fields } = data as Record<string, unknown>;
  if (raw === null || raw === undefined || raw === '') return { fields, notify: null };
  if (!kind.notify || typeof raw !== 'string' || !UUID.test(raw)) {
    throw new SectorRecordError(`Campo «${kind.notify ?? 'Persona da avvisare'}» non valido`);
  }
  return { fields, notify: raw.toLowerCase() };
}

function notifyOf(data: unknown): string | null {
  const value = (data as Record<string, unknown> | null)?.[NOTIFY_KEY];
  return typeof value === 'string' ? value : null;
}

function validate(kind: SectorRecordKind, input: unknown): Record<string, unknown> {
  const { fields: data, notify } = splitNotify(kind, input);
  const parsed = fieldListSchema(kind.fields).safeParse(data ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = kind.fields.find((f) => f.key === issue?.path[0]);
    throw new SectorRecordError(
      field
        ? `Campo «${field.label}» non valido`
        : `Dati non validi: ${issue?.message ?? 'controlla i campi'}`,
    );
  }
  for (const key of [kind.dateField, kind.dueField]) {
    const value = key ? parsed.data[key] : undefined;
    if (typeof value === 'string' && !parseIsoDate(value)) {
      const label = kind.fields.find((f) => f.key === key)?.label ?? key;
      throw new SectorRecordError(`Campo «${label}»: data inesistente`);
    }
  }
  return notify ? { ...parsed.data, [NOTIFY_KEY]: notify } : parsed.data;
}

/** The reason of a correction or a voiding: required, 3 to 500 characters. */
function reasonOf(value: unknown, what: 'rettifica' | 'annullamento'): string {
  const reason = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < REASON_MIN) {
    throw new SectorRecordError(
      `Indica il motivo ${what === 'rettifica' ? 'della rettifica' : 'dell’annullamento'} (almeno ${REASON_MIN} caratteri)`,
      400,
      'REASON_REQUIRED',
    );
  }
  if (reason.length > REASON_MAX) {
    throw new SectorRecordError(`Il motivo può avere al massimo ${REASON_MAX} caratteri`);
  }
  return reason;
}

/** The same JSON whatever the order of the keys (PostgreSQL reorders them in jsonb). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function conflict(): SectorRecordError {
  return new SectorRecordError(
    'La voce è stata modificata nel frattempo: ricarica la pagina e riprova',
    409,
    'VERSION_CONFLICT',
  );
}

function voidedError(): SectorRecordError {
  return new SectorRecordError('La voce è annullata: non si può più modificare', 409, 'VOIDED');
}

function kindOf(access: Access, kind: string): SectorRecordKind {
  const found = sectorRecordKind(access.definition.id, kind);
  if (!found) throw new SectorRecordError(`Tipo di voce sconosciuto: ${kind}`);
  return found;
}

/** The row of the history for the entry as it is now. */
function versionOf(
  row: {
    id: string;
    orgId: string;
    version: number;
    title: string;
    data: unknown;
    occurredOn: Date | null;
    dueDate: Date | null;
  },
  action: 'CREATED' | 'CORRECTED' | 'VOIDED',
  reason: string | null,
  channel: SectorChannel,
  userId: string,
): Prisma.SectorRecordVersionUncheckedCreateInput {
  return {
    recordId: row.id,
    orgId: row.orgId,
    version: row.version,
    action,
    title: row.title,
    data: row.data ?? {},
    occurredOn: row.occurredOn,
    dueDate: row.dueDate,
    reason,
    channel,
    changedBy: userId,
  };
}

const INCLUDE = {
  author: { select: { id: true, email: true } },
  attachments: {
    select: { id: true, fileName: true, mimeType: true, fileSize: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.SectorRecordInclude;

type RecordRow = Prisma.SectorRecordGetPayload<{ include: typeof INCLUDE }>;

function toView(
  row: RecordRow,
  access: Access,
  today: string,
  people: ReadonlyMap<string, string>,
): SectorRecordView {
  const kind = access.definition.records.find((r) => r.kind === row.kind);
  const notify = kind?.notify ? notifyOf(row.data) : null;
  return {
    id: row.id,
    feature: row.feature,
    kind: row.kind,
    kindLabel: kind?.label ?? row.kind,
    title: row.title,
    data: (row.data ?? {}) as Record<string, unknown>,
    occurredOn: row.occurredOn ? toIsoDate(row.occurredOn) : null,
    dueDate: row.dueDate ? toIsoDate(row.dueDate) : null,
    daysLeft: row.dueDate ? daysUntil(row.dueDate, today) : null,
    author: row.author ? { id: row.author.id, email: row.author.email } : null,
    notify: notify
      ? { id: notify, label: people.get(notify) ?? 'Persona non più nell’organizzazione' }
      : null,
    mine: row.createdBy === access.grant.principal.userId,
    version: row.version,
    voided:
      row.voidedAt && row.voidReason
        ? {
            at: row.voidedAt.toISOString(),
            reason: row.voidReason,
            by: row.voidedBy ? (people.get(row.voidedBy) ?? null) : null,
          }
        : null,
    attachments: row.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      createdAt: a.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What a grant reaches: the whole register, or the caller's own entries. */
function reach(access: Access): Prisma.SectorRecordWhereInput {
  const { principal } = access.grant;
  return {
    orgId: principal.tenantId,
    feature: access.definition.id,
    ...(access.grant.scope === 'tenant' ? {} : { createdBy: principal.userId }),
  };
}

export type SectorFilters = {
  kind?: string;
  /** Entries in force (default), voided ones, or both. */
  state?: 'active' | 'voided' | 'all';
  search?: string;
  from?: string;
  to?: string;
  expiringWithinDays?: number;
};

/** The entries a grant reaches, narrowed by the filters of the register. */
function filterWhere(
  access: Access,
  input: SectorFilters,
  today: string,
): Prisma.SectorRecordWhereInput {
  const where: Prisma.SectorRecordWhereInput = { ...reach(access) };
  const state = input.state ?? 'active';
  if (state === 'active') where.voidedAt = null;
  if (state === 'voided') where.voidedAt = { not: null };
  if (input.kind) where.kind = kindOf(access, input.kind).kind;
  const from = input.from ? parseIsoDate(input.from) : null;
  const to = input.to ? parseIsoDate(input.to) : null;
  if ((input.from && !from) || (input.to && !to)) {
    throw new SectorRecordError('Le date del filtro devono essere AAAA-MM-GG');
  }
  if (from || to) {
    where.occurredOn = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (input.expiringWithinDays !== undefined) {
    const horizon = parseIsoDate(today)!;
    horizon.setUTCDate(horizon.getUTCDate() + input.expiringWithinDays);
    where.dueDate = { not: null, lte: horizon };
  }
  const search = input.search?.trim().slice(0, SEARCH_MAX);
  if (search) where.title = { contains: search, mode: 'insensitive' };
  return where;
}

/** Files an entry accepts: documents and photos, recognized from their content. */
const ATTACHMENT_MIME: Partial<Record<string, string>> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const MAX_ATTACHMENTS_PER_RECORD = 10;
const MAX_EXPORT_ROWS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export class SectorRecordService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      clock?: () => Date;
      /** Reminds a deadline at once when it is already close (the compliance service). */
      remindNow?: (input: { tenantId: string; deadlineId: string }) => Promise<unknown>;
      /** Where the files of the entries are kept; without it, entries take no files. */
      storage?: StorageService;
      maxAttachmentBytes?: number;
    } = {},
  ) {}

  private today(): string {
    return todayInRome(this.options.clock?.() ?? new Date());
  }

  async list(
    principal: Principal,
    input: {
      feature: string;
      channel: SectorChannel;
      kind?: string;
      state?: 'active' | 'voided' | 'all';
      search?: string;
      from?: string;
      to?: string;
      expiringWithinDays?: number;
      page?: number;
      limit?: number;
    },
  ): Promise<SectorRegisterPage> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'read',
      input.channel,
    );
    const canManage = await this.canManage(principal, input.feature, input.channel);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const page = Math.max(input.page ?? 1, 1);
    const today = this.today();
    const where = filterWhere(access, input, today);

    const [total, rows] = await Promise.all([
      this.prisma.sectorRecord.count({ where }),
      this.prisma.sectorRecord.findMany({
        where,
        include: INCLUDE,
        orderBy:
          input.expiringWithinDays !== undefined
            ? [{ dueDate: 'asc' }, { createdAt: 'desc' }]
            : [{ occurredOn: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const labels = await this.labelsOf(rows);
    return {
      feature: {
        id: access.definition.id,
        label: access.definition.label,
        description: access.definition.description,
      },
      kinds: access.definition.records,
      canManage,
      canVoid: principal.delegation
        ? principal.delegation.operations.includes('DELETE')
        : canManage,
      people: await this.people(principal, input.feature, input.channel),
      items: rows.map((r) => toView(r, access, today, labels)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** The labels of the people named in these entries, or who voided them. */
  private async labelsOf(
    rows: ReadonlyArray<{ data: unknown; voidedBy?: string | null }>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows.flatMap((r) => [notifyOf(r.data), r.voidedBy ?? null]).filter((v) => v !== null),
      ),
    ];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    });
    return new Map(users.map((u) => [u.id, personLabel(u)]));
  }

  /** Who the writer may name as the person to remind (see SectorRegisterPage.people). */
  private async people(
    principal: Principal,
    feature: string,
    channel: SectorChannel,
  ): Promise<SectorPerson[]> {
    // Who works through a delegation never sees the people of the grantor.
    if (principal.delegation) return [];
    let manage: Access;
    try {
      manage = await authorizeSector(this.prisma, principal, feature, 'manage', channel);
    } catch {
      return [];
    }
    if (!manage.definition.records.some((k) => k.notify)) return [];
    const rows = await this.prisma.membership.findMany({
      where: {
        orgId: principal.tenantId,
        status: 'ACTIVE',
        ...(manage.grant.scope === 'tenant' ? {} : { userId: principal.userId }),
      },
      select: { user: { select: { id: true, email: true } } },
      take: 1000,
    });
    return rows
      .map((r) => ({ id: r.user.id, label: personLabel(r.user) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'it'));
  }

  /**
   * The person to remind must be an active person of the organization, and a member writing
   * their own entries can name only themselves.
   */
  private async checkNotify(access: Access, data: Record<string, unknown>): Promise<void> {
    const id = notifyOf(data);
    if (!id) return;
    const { principal } = access.grant;
    if (principal.delegation) {
      throw new SectorRecordError(
        'Con una delega non si indicano persone dell’organizzazione da avvisare',
        403,
      );
    }
    if (access.grant.scope !== 'tenant' && id !== principal.userId) {
      throw new SectorRecordError('Come persona da avvisare puoi indicare solo te stesso', 403);
    }
    const member = await this.prisma.membership.findFirst({
      where: { orgId: principal.tenantId, userId: id, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!member) {
      throw new SectorRecordError(
        'La persona da avvisare non è tra le persone dell’organizzazione',
      );
    }
  }

  private async canManage(principal: Principal, feature: string, channel: SectorChannel) {
    // Through a delegation: writing only when the delegation includes it.
    if (principal.delegation) {
      return principal.delegation.operations.some((o) => o === 'CREATE' || o === 'UPDATE');
    }
    try {
      await authorizeSector(this.prisma, principal, feature, 'manage', channel);
      return true;
    } catch {
      return false;
    }
  }

  async get(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string },
  ): Promise<SectorRecordView> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'read',
      input.channel,
    );
    const row = await this.prisma.sectorRecord.findFirst({
      where: { ...reach(access), id: input.id },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Voce non trovata');
    return toView(row, access, this.today(), await this.labelsOf([row]));
  }

  async create(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; kind: string; data: unknown },
  ): Promise<SectorRecordView> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'manage',
      input.channel,
    );
    const kind = kindOf(access, input.kind);
    const data = validate(kind, input.data);
    await this.checkNotify(access, data);
    const { deadlineId, id } = await withTransaction(this.prisma, async (tx) => {
      const row = await tx.sectorRecord.create({
        data: {
          orgId: principal.tenantId,
          feature: access.definition.id,
          kind: kind.kind,
          title: recordTitle(kind, data),
          data: data as Prisma.InputJsonObject,
          occurredOn: dateOf(data, kind.dateField),
          dueDate: dateOf(data, kind.dueField),
          createdBy: principal.userId,
          updatedBy: principal.userId,
        },
      });
      await tx.sectorRecordVersion.create({
        data: versionOf(row, 'CREATED', null, input.channel, principal.userId),
      });
      const deadline = await this.syncDeadline(tx, access, kind, row);
      await new AuditService(tx).logEvent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        eventType: 'SECTOR_RECORD_CREATED',
        payload: { recordId: row.id, feature: row.feature, kind: row.kind, channel: input.channel },
      });
      return { id: row.id, deadlineId: deadline };
    });
    await this.remind(principal.tenantId, deadlineId);
    return this.get(principal, { feature: input.feature, channel: input.channel, id });
  }

  /**
   * A correction: the new content, with its reason, becomes a new version; the previous ones stay
   * in the history. `expectedVersion`, when given, must be the current one (no lost update).
   */
  async update(
    principal: Principal,
    input: {
      feature: string;
      channel: SectorChannel;
      id: string;
      data: unknown;
      reason: unknown;
      expectedVersion?: number;
    },
  ): Promise<SectorRecordView> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'manage',
      input.channel,
    );
    const existing = await this.prisma.sectorRecord.findFirst({
      where: { ...reach(access), id: input.id },
    });
    if (!existing) throw new NotFoundError('Voce non trovata');
    if (existing.voidedAt) throw voidedError();
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw conflict();
    }
    const kind = kindOf(access, existing.kind);
    const data = validate(kind, input.data);
    const reason = reasonOf(input.reason, 'rettifica');
    if (canonical(data) === canonical(existing.data)) {
      throw new SectorRecordError('Nessuna modifica da registrare', 400, 'NO_CHANGE');
    }
    await this.checkNotify(access, data);
    const deadlineId = await withTransaction(this.prisma, async (tx) => {
      // Only from the version just read: a change made meanwhile is never overwritten.
      const done = await tx.sectorRecord.updateMany({
        where: { id: existing.id, version: existing.version, voidedAt: null },
        data: {
          title: recordTitle(kind, data),
          data: data as Prisma.InputJsonObject,
          occurredOn: dateOf(data, kind.dateField),
          dueDate: dateOf(data, kind.dueField),
          updatedBy: principal.userId,
          version: existing.version + 1,
        },
      });
      if (done.count !== 1) throw conflict();
      const row = await tx.sectorRecord.findUniqueOrThrow({ where: { id: existing.id } });
      await tx.sectorRecordVersion.create({
        data: versionOf(row, 'CORRECTED', reason, input.channel, principal.userId),
      });
      const deadline = await this.syncDeadline(tx, access, kind, row);
      await new AuditService(tx).logEvent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        eventType: 'SECTOR_RECORD_UPDATED',
        payload: {
          recordId: row.id,
          feature: row.feature,
          kind: row.kind,
          version: row.version,
          channel: input.channel,
        },
      });
      return deadline;
    });
    await this.remind(principal.tenantId, deadlineId);
    return this.get(principal, { feature: input.feature, channel: input.channel, id: existing.id });
  }

  /**
   * Voids an entry, with its reason: it stays in the register with its files and history, out of
   * the lists and exports unless asked for, and its deadline is closed (no more reminders).
   */
  async void(
    principal: Principal,
    input: {
      feature: string;
      channel: SectorChannel;
      id: string;
      reason: unknown;
      expectedVersion?: number;
    },
  ): Promise<SectorRecordView> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'manage',
      input.channel,
    );
    const existing = await this.prisma.sectorRecord.findFirst({
      where: { ...reach(access), id: input.id },
    });
    if (!existing) throw new NotFoundError('Voce non trovata');
    if (existing.voidedAt) {
      throw new SectorRecordError('La voce è già annullata', 409, 'VOIDED');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw conflict();
    }
    const reason = reasonOf(input.reason, 'annullamento');
    const now = this.options.clock?.() ?? new Date();
    await withTransaction(this.prisma, async (tx) => {
      const done = await tx.sectorRecord.updateMany({
        where: { id: existing.id, version: existing.version, voidedAt: null },
        data: {
          voidedAt: now,
          voidedBy: principal.userId,
          voidReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        },
      });
      if (done.count !== 1) throw conflict();
      const row = await tx.sectorRecord.findUniqueOrThrow({ where: { id: existing.id } });
      await tx.sectorRecordVersion.create({
        data: versionOf(row, 'VOIDED', reason, input.channel, principal.userId),
      });
      // The deadline stays, closed: what was due is still among the closed deadlines.
      await tx.complianceDeadline.updateMany({
        where: { sectorRecordId: row.id, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: now },
      });
      await new AuditService(tx).logEvent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        eventType: 'SECTOR_RECORD_VOIDED',
        payload: {
          recordId: row.id,
          feature: row.feature,
          kind: row.kind,
          version: row.version,
          channel: input.channel,
        },
      });
    });
    return this.get(principal, { feature: input.feature, channel: input.channel, id: existing.id });
  }

  /** The history of an entry, oldest first, with the same access as the entry itself. */
  async versions(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string },
  ): Promise<SectorRecordVersionView[]> {
    const { record } = await this.reachable(principal, input, 'read');
    const rows = await this.prisma.sectorRecordVersion.findMany({
      where: { recordId: record.id, orgId: principal.tenantId },
      include: { author: { select: { id: true, email: true } } },
      orderBy: { version: 'asc' },
    });
    return rows.map((v) => ({
      version: v.version,
      action: v.action,
      title: v.title,
      data: (v.data ?? {}) as Record<string, unknown>,
      occurredOn: v.occurredOn ? toIsoDate(v.occurredOn) : null,
      dueDate: v.dueDate ? toIsoDate(v.dueDate) : null,
      reason: v.reason,
      channel: v.channel,
      author: v.author ? personLabel(v.author) : null,
      changedAt: v.createdAt.toISOString(),
    }));
  }

  /**
   * The register as a file: CSV and Excel with every field, PDF with the main columns for a
   * check. The same entries the caller reads (members: their own), with the filters of the page;
   * refused when the organization's exports are off. At most 10,000 entries.
   */
  async export(
    principal: Principal,
    input: SectorFilters & {
      feature: string;
      channel: SectorChannel;
      format: RegisterExportFormat;
    },
  ): Promise<TableFile & { count: number }> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'read',
      input.channel,
    );
    if (!featureEnabled(principal.disabledFeatures, 'exports')) {
      throw new FeatureDisabledError('exports', access.grant.permission);
    }
    const today = this.today();
    const where = filterWhere(access, input, today);
    const total = await this.prisma.sectorRecord.count({ where });
    if (total > MAX_EXPORT_ROWS) {
      throw new SectorRecordError(
        `Troppe voci da esportare (${total}): restringi il periodo, al massimo ${MAX_EXPORT_ROWS}`,
        409,
        'EXPORT_TOO_LARGE',
      );
    }
    const rows = await this.prisma.sectorRecord.findMany({
      where,
      include: INCLUDE,
      orderBy: [{ occurredOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    const labels = await this.labelsOf(rows);
    const file = await registerTable({
      label: access.definition.label,
      kinds: access.definition.records,
      records: rows.map((r) => toView(r, access, today, labels)),
      format: input.format,
      today,
    });
    await new AuditService(this.prisma).logEvent({
      tenantId: principal.tenantId,
      userId: principal.userId,
      eventType: 'SECTOR_RECORDS_EXPORTED',
      payload: {
        feature: access.definition.id,
        format: input.format,
        count: rows.length,
        state: input.state ?? 'active',
        scope: access.grant.scope,
        channel: input.channel,
      },
    });
    return { ...file, count: rows.length };
  }

  private async deleteFile(tenantId: string, storagePath: string): Promise<void> {
    await this.options.storage?.delete(tenantId, storagePath).catch(() => undefined);
  }

  /** The entry the caller reaches for this operation, or NotFoundError. */
  private async reachable(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string },
    operation: 'read' | 'manage',
  ) {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      operation,
      input.channel,
    );
    const record = await this.prisma.sectorRecord.findFirst({
      where: { ...reach(access), id: input.id },
      select: {
        id: true,
        feature: true,
        kind: true,
        voidedAt: true,
        _count: { select: { attachments: true } },
      },
    });
    if (!record) throw new NotFoundError('Voce non trovata');
    return { access, record };
  }

  /**
   * Attaches a file to an entry: a PDF or a photo (JPEG, PNG, WEBP), recognized from its content
   * whatever its name says, within the size limit and at most 10 per entry.
   */
  async addAttachment(
    principal: Principal,
    input: {
      feature: string;
      channel: SectorChannel;
      id: string;
      fileName: string;
      content: Buffer;
    },
  ): Promise<SectorRecordView> {
    // Access first: nothing about the server is told to someone who cannot reach the entry.
    const { record } = await this.reachable(principal, input, 'manage');
    if (record.voidedAt) throw voidedError();
    const storage = this.options.storage;
    if (!storage) throw new SectorRecordError('Archivio dei file non configurato', 409);
    const max = this.options.maxAttachmentBytes ?? DEFAULT_MAX_BYTES;
    if (input.content.length === 0) throw new SectorRecordError('Il file è vuoto');
    if (input.content.length > max) {
      throw new SectorRecordError(
        `Il file supera il limite di ${Math.round((max / 1024 / 1024) * 10) / 10} MB`,
        400,
        'ATTACHMENT_TOO_LARGE',
      );
    }
    const kind = detectFileKind(input.content);
    const mimeType = kind ? ATTACHMENT_MIME[kind] : undefined;
    if (!mimeType) {
      throw new SectorRecordError(
        'Formato non ammesso: carica un PDF o una foto (JPEG, PNG, WEBP)',
        400,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    if (record._count.attachments >= MAX_ATTACHMENTS_PER_RECORD) {
      throw new SectorRecordError(
        `Una voce può avere al massimo ${MAX_ATTACHMENTS_PER_RECORD} file`,
        409,
        'TOO_MANY_ATTACHMENTS',
      );
    }
    const fileName = (input.fileName.trim() || 'documento').slice(0, 255);
    const saved = await storage.save(principal.tenantId, fileName, input.content, mimeType);
    try {
      await withTransaction(this.prisma, async (tx) => {
        const row = await tx.sectorRecordAttachment.create({
          data: {
            orgId: principal.tenantId,
            recordId: record.id,
            fileName,
            mimeType,
            fileSize: input.content.length,
            storagePath: saved.storagePath,
            contentHash: createHash('sha256').update(input.content).digest('hex'),
            uploadedBy: principal.userId,
          },
        });
        await new AuditService(tx).logEvent({
          tenantId: principal.tenantId,
          userId: principal.userId,
          eventType: 'SECTOR_RECORD_FILE_ADDED',
          payload: {
            recordId: record.id,
            attachmentId: row.id,
            feature: record.feature,
            mimeType,
            fileSize: input.content.length,
            channel: input.channel,
          },
        });
      });
    } catch (err) {
      // No row: the file just written would be an orphan.
      await this.deleteFile(principal.tenantId, saved.storagePath);
      throw err;
    }
    return this.get(principal, input);
  }

  /** The file of an entry, with the same access as the entry itself. */
  async downloadAttachment(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string; attachmentId: string },
  ): Promise<{ fileName: string; mimeType: string; content: Buffer }> {
    const { record } = await this.reachable(principal, input, 'read');
    const storage = this.options.storage;
    if (!storage) throw new NotFoundError('File non trovato');
    const file = await this.prisma.sectorRecordAttachment.findFirst({
      where: { id: input.attachmentId, recordId: record.id, orgId: principal.tenantId },
    });
    if (!file) throw new NotFoundError('File non trovato');
    const content = await storage.read(principal.tenantId, file.storagePath);
    return { fileName: file.fileName, mimeType: file.mimeType, content };
  }

  async removeAttachment(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string; attachmentId: string },
  ): Promise<SectorRecordView> {
    const { record } = await this.reachable(principal, input, 'manage');
    if (record.voidedAt) throw voidedError();
    const file = await this.prisma.sectorRecordAttachment.findFirst({
      where: { id: input.attachmentId, recordId: record.id, orgId: principal.tenantId },
    });
    if (!file) throw new NotFoundError('File non trovato');
    await withTransaction(this.prisma, async (tx) => {
      await tx.sectorRecordAttachment.delete({ where: { id: file.id } });
      await new AuditService(tx).logEvent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        eventType: 'SECTOR_RECORD_FILE_REMOVED',
        payload: {
          recordId: record.id,
          attachmentId: file.id,
          feature: record.feature,
          channel: input.channel,
        },
      });
    });
    await this.deleteFile(principal.tenantId, file.storagePath);
    return this.get(principal, input);
  }

  /**
   * Keeps the deadline of an entry in step with its expiry: created, moved (reopened, reminders
   * sent again), renamed or removed. Returns the deadline to remind, if any.
   */
  private async syncDeadline(
    tx: PrismaTx,
    access: Access,
    kind: SectorRecordKind,
    row: {
      id: string;
      orgId: string;
      title: string;
      dueDate: Date | null;
      createdBy: string | null;
      data: unknown;
    },
  ): Promise<string | null> {
    // The person named in the entry gets the reminders too, and sees the deadline as theirs.
    const userId = kind.notify ? notifyOf(row.data) : null;
    const existing = await tx.complianceDeadline.findUnique({
      where: { sectorRecordId: row.id },
      select: { id: true, dueDate: true },
    });
    if (!row.dueDate) {
      if (existing) await tx.complianceDeadline.delete({ where: { id: existing.id } });
      return null;
    }
    // The kind of entry says what expires («Visita medica: Marco T. · Idoneo»), even when the
    // title alone is short («Assegnazione UMA: 2026»).
    const full = deadlineTitle(kind, row.title);
    const title =
      full.length > DEADLINE_TITLE_MAX ? `${full.slice(0, DEADLINE_TITLE_MAX - 1)}…` : full;
    const allowed = deadlineCategoriesOf(access.module);
    const category =
      kind.deadlineCategory && allowed.includes(kind.deadlineCategory)
        ? kind.deadlineCategory
        : 'ALTRO';
    if (!existing) {
      const created = await tx.complianceDeadline.create({
        data: {
          tenantId: row.orgId,
          createdBy: access.grant.principal.userId,
          userId,
          category,
          title,
          dueDate: row.dueDate,
          sectorRecordId: row.id,
        },
        select: { id: true },
      });
      return created.id;
    }
    const moved = existing.dueDate.getTime() !== row.dueDate.getTime();
    if (moved) {
      // A new expiry (e.g. a renewal): the reminders start again for the new date.
      await tx.complianceReminder.deleteMany({ where: { deadlineId: existing.id } });
    }
    await tx.complianceDeadline.update({
      where: { id: existing.id },
      data: {
        title,
        category,
        userId,
        dueDate: row.dueDate,
        ...(moved ? { status: 'OPEN', closedAt: null } : {}),
      },
    });
    return moved ? existing.id : null;
  }

  private async remind(tenantId: string, deadlineId: string | null): Promise<void> {
    if (!deadlineId || !this.options.remindNow) return;
    // A failed reminder never undoes the entry: the daily run sends it again.
    await this.options.remindNow({ tenantId, deadlineId }).catch(() => undefined);
  }
}
