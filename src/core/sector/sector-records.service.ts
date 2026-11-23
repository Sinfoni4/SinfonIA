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
import { fieldListSchema } from '../modules/module.contract.js';

import type { PrismaTx } from '../../data/types/prisma.js';
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
  mine: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SectorRegisterPage = {
  feature: { id: string; label: string; description: string };
  kinds: readonly SectorRecordKind[];
  canManage: boolean;
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
  const grant = authorize(principal, `${feature as SectorFeature}.${operation}`);
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

function validate(kind: SectorRecordKind, data: unknown): Record<string, unknown> {
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
  return parsed.data;
}

function kindOf(access: Access, kind: string): SectorRecordKind {
  const found = sectorRecordKind(access.definition.id, kind);
  if (!found) throw new SectorRecordError(`Tipo di voce sconosciuto: ${kind}`);
  return found;
}

type RecordRow = Prisma.SectorRecordGetPayload<{
  include: { author: { select: { id: true; email: true } } };
}>;

function toView(row: RecordRow, access: Access, today: string): SectorRecordView {
  const kind = access.definition.records.find((r) => r.kind === row.kind);
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
    mine: row.createdBy === access.grant.principal.userId,
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

const AUTHOR = { author: { select: { id: true, email: true } } } as const;

export class SectorRecordService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      clock?: () => Date;
      /** Reminds a deadline at once when it is already close (the compliance service). */
      remindNow?: (input: { tenantId: string; deadlineId: string }) => Promise<unknown>;
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
    const where: Prisma.SectorRecordWhereInput = { ...reach(access) };
    if (input.kind) where.kind = kindOf(access, input.kind).kind;
    const from = input.from ? parseIsoDate(input.from) : null;
    const to = input.to ? parseIsoDate(input.to) : null;
    if ((input.from && !from) || (input.to && !to)) {
      throw new SectorRecordError('Le date del filtro devono essere AAAA-MM-GG');
    }
    if (from || to)
      where.occurredOn = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (input.expiringWithinDays !== undefined) {
      const horizon = parseIsoDate(today)!;
      horizon.setUTCDate(horizon.getUTCDate() + input.expiringWithinDays);
      where.dueDate = { not: null, lte: horizon };
    }
    const search = input.search?.trim().slice(0, SEARCH_MAX);
    if (search) where.title = { contains: search, mode: 'insensitive' };

    const [total, rows] = await Promise.all([
      this.prisma.sectorRecord.count({ where }),
      this.prisma.sectorRecord.findMany({
        where,
        include: AUTHOR,
        orderBy:
          input.expiringWithinDays !== undefined
            ? [{ dueDate: 'asc' }, { createdAt: 'desc' }]
            : [{ occurredOn: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      feature: {
        id: access.definition.id,
        label: access.definition.label,
        description: access.definition.description,
      },
      kinds: access.definition.records,
      canManage,
      items: rows.map((r) => toView(r, access, today)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private async canManage(principal: Principal, feature: string, channel: SectorChannel) {
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
      include: AUTHOR,
    });
    if (!row) throw new NotFoundError('Voce non trovata');
    return toView(row, access, this.today());
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

  async update(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string; data: unknown },
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
    const kind = kindOf(access, existing.kind);
    const data = validate(kind, input.data);
    const deadlineId = await withTransaction(this.prisma, async (tx) => {
      const row = await tx.sectorRecord.update({
        where: { id: existing.id },
        data: {
          title: recordTitle(kind, data),
          data: data as Prisma.InputJsonObject,
          occurredOn: dateOf(data, kind.dateField),
          dueDate: dateOf(data, kind.dueField),
          updatedBy: principal.userId,
        },
      });
      const deadline = await this.syncDeadline(tx, access, kind, row);
      await new AuditService(tx).logEvent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        eventType: 'SECTOR_RECORD_UPDATED',
        payload: { recordId: row.id, feature: row.feature, kind: row.kind, channel: input.channel },
      });
      return deadline;
    });
    await this.remind(principal.tenantId, deadlineId);
    return this.get(principal, { feature: input.feature, channel: input.channel, id: existing.id });
  }

  async remove(
    principal: Principal,
    input: { feature: string; channel: SectorChannel; id: string },
  ): Promise<void> {
    const access = await authorizeSector(
      this.prisma,
      principal,
      input.feature,
      'manage',
      input.channel,
    );
    const existing = await this.prisma.sectorRecord.findFirst({
      where: { ...reach(access), id: input.id },
      select: { id: true, feature: true, kind: true },
    });
    if (!existing) throw new NotFoundError('Voce non trovata');
    await withTransaction(this.prisma, async (tx) => {
      // Its deadline goes with it (ON DELETE CASCADE), reminders included.
      await tx.sectorRecord.delete({ where: { id: existing.id } });
      await new AuditService(tx).logEvent({
        tenantId: principal.tenantId,
        userId: principal.userId,
        eventType: 'SECTOR_RECORD_DELETED',
        payload: {
          recordId: existing.id,
          feature: existing.feature,
          kind: existing.kind,
          channel: input.channel,
        },
      });
    });
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
    },
  ): Promise<string | null> {
    const existing = await tx.complianceDeadline.findUnique({
      where: { sectorRecordId: row.id },
      select: { id: true, dueDate: true },
    });
    if (!row.dueDate) {
      if (existing) await tx.complianceDeadline.delete({ where: { id: existing.id } });
      return null;
    }
    const full = `${access.definition.label}: ${row.title}`;
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
          userId: null,
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
