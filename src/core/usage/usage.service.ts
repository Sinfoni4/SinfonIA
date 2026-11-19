import { z } from 'zod';

import { NotFoundError } from '../../data/errors/errors.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { periodBounds } from '../network/network-stats.service.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type { StatsPeriodKind } from '../network/network-stats.service.js';
import type { PrismaClient, UsageKind } from '@prisma/client';

/**
 * AGX-07: usage events (audit AG09). Each unit of work done for an organization leaves one row in
 * `usage_event`, written in the same transaction as the work and with a unique key, so a retry
 * never counts twice.
 *
 * Three things are kept apart:
 * - the technical usage: the event, with its quantity and unit;
 * - the internal cost: rate × quantity, computed when reading from the rates in the configuration
 *   (`USAGE_RATES`), never stored, shown only in the platform console;
 * - what is charged to whom: a commercial rule still to be decided, not part of this.
 *
 * A wrong event is never changed (a trigger refuses updates): the platform reverses it with a new
 * event of opposite quantity that points to it.
 */

export const USAGE_KINDS: readonly UsageKind[] = [
  'DOCUMENT_RECEIVED',
  'OCR_PAGES',
  'AI_CALL',
  'AI_TOKENS',
  'PRACTICE_OPENED',
  'PRACTICE_COMPLETED',
  'DOCUMENT_REQUESTED',
  'ASSISTANCE_CLOSED',
];

export const USAGE_UNITS: Record<UsageKind, string> = {
  DOCUMENT_RECEIVED: 'document',
  OCR_PAGES: 'page',
  AI_CALL: 'call',
  AI_TOKENS: 'token',
  PRACTICE_OPENED: 'practice',
  PRACTICE_COMPLETED: 'practice',
  DOCUMENT_REQUESTED: 'request',
  ASSISTANCE_CLOSED: 'request',
};

export type UsageInput = {
  /** Unique for the work: the same key twice is recorded once. */
  key: string;
  tenantId: string;
  kind: UsageKind;
  quantity?: number;
  /** The organization that did the work, when not `tenantId` (a network through a delegation). */
  actorOrgId?: string | null;
  userId?: string | null;
  practiceId?: string | null;
  occurredAt?: Date;
};

/**
 * Records usage events inside the caller's transaction. A key already recorded is skipped, so the
 * same work done again (a retry, a redelivery) is counted once. Zero quantities are not recorded.
 */
export async function recordUsage(tx: PrismaLike, events: UsageInput[]): Promise<void> {
  const rows = events
    .filter((e) => (e.quantity ?? 1) > 0)
    .map((e) => ({
      idempotencyKey: e.key,
      tenantId: e.tenantId,
      actorOrgId: e.actorOrgId && e.actorOrgId !== e.tenantId ? e.actorOrgId : null,
      userId: e.userId ?? null,
      kind: e.kind,
      quantity: Math.round(e.quantity ?? 1),
      unit: USAGE_UNITS[e.kind],
      practiceId: e.practiceId ?? null,
      ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
    }));
  if (rows.length === 0) return;
  await tx.usageEvent.createMany({ data: rows, skipDuplicates: true });
}

/**
 * The usage of a file received: the document, and the pages read with OCR (none for a PDF with a
 * text layer or a text file). Keyed on the attachment, so the same file is never counted twice.
 */
export function attachmentUsage(
  attachmentId: string,
  ocrResult?: { extraction?: { source: string; pages: number; ocrPages?: number } },
): Array<Pick<UsageInput, 'key' | 'kind' | 'quantity'>> {
  const extraction = ocrResult?.extraction;
  const ocrPages =
    extraction?.ocrPages ?? (extraction?.source.startsWith('ocr_') ? extraction.pages : 0);
  return [
    { key: `document.received:${attachmentId}`, kind: 'DOCUMENT_RECEIVED' },
    { key: `ocr.pages:${attachmentId}`, kind: 'OCR_PAGES', quantity: ocrPages },
  ];
}

// --- Rates (internal cost) ----------------------------------------------------------------------

/** Euro per unit of each kind; kinds without a rate have no cost. */
export type UsageRates = Partial<Record<UsageKind, number>>;

const RatesSchema = z
  .record(z.string(), z.number().nonnegative().max(1000))
  .refine((r) => Object.keys(r).every((k) => (USAGE_KINDS as readonly string[]).includes(k)), {
    message: `USAGE_RATES: the keys must be among ${USAGE_KINDS.join(', ')}`,
  });

/** Reads `USAGE_RATES` (JSON, euro per unit); a wrong value stops the start, it is never ignored. */
export function parseUsageRates(raw: string | undefined): UsageRates {
  if (!raw || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('USAGE_RATES must be a JSON object, e.g. {"OCR_PAGES": 0.002}');
  }
  return RatesSchema.parse(parsed);
}

// --- Reports ------------------------------------------------------------------------------------

export type UsagePeriod = { kind: StatsPeriodKind; previous: boolean; from: string; to: string };

function periodView(kind: StatsPeriodKind, previous: boolean, from: Date, to: Date): UsagePeriod {
  return {
    kind,
    previous,
    from: from.toISOString().slice(0, 10),
    to: new Date(to.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10),
  };
}

function totalsByKind(rows: Array<{ kind: UsageKind; _sum: { quantity: number | null } }>) {
  const out = new Map<UsageKind, number>();
  for (const r of rows) out.set(r.kind, (out.get(r.kind) ?? 0) + (r._sum.quantity ?? 0));
  return out;
}

export type OrganizationUsage = {
  period: UsagePeriod;
  /** Everything done for the organization, by kind (reversals already subtracted). */
  totals: Array<{ kind: UsageKind; unit: string; quantity: number }>;
  /** The part done by other organizations through a delegation, by organization and kind. */
  byOthers: Array<{
    orgId: string;
    orgName: string;
    items: Array<{ kind: UsageKind; quantity: number }>;
  }>;
};

/** The usage of one organization: its own data, so nothing is hidden. */
export async function organizationUsage(
  prisma: PrismaClient,
  input: { tenantId: string; kind: StatsPeriodKind; previous: boolean; now?: Date },
): Promise<OrganizationUsage> {
  const { from, to } = periodBounds(input.kind, input.previous, input.now);
  const where = { tenantId: input.tenantId, occurredAt: { gte: from, lt: to } };
  const [byKind, byActor] = await Promise.all([
    prisma.usageEvent.groupBy({ by: ['kind'], where, _sum: { quantity: true } }),
    prisma.usageEvent.groupBy({
      by: ['actorOrgId', 'kind'],
      where: { ...where, actorOrgId: { not: null } },
      _sum: { quantity: true },
    }),
  ]);
  const totals = totalsByKind(byKind);
  const actorIds = [...new Set(byActor.map((r) => r.actorOrgId).filter((id) => id !== null))];
  const names = new Map(
    (
      await prisma.tenant.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
    ).map((t) => [t.id, t.name]),
  );
  return {
    period: periodView(input.kind, input.previous, from, to),
    totals: USAGE_KINDS.map((kind) => ({
      kind,
      unit: USAGE_UNITS[kind],
      quantity: totals.get(kind) ?? 0,
    })),
    byOthers: actorIds
      .map((orgId) => ({
        orgId,
        orgName: names.get(orgId) ?? '—',
        items: byActor
          .filter((r) => r.actorOrgId === orgId && (r._sum.quantity ?? 0) !== 0)
          .map((r) => ({ kind: r.kind, quantity: r._sum.quantity ?? 0 }))
          .sort((a, b) => USAGE_KINDS.indexOf(a.kind) - USAGE_KINDS.indexOf(b.kind)),
      }))
      .filter((o) => o.items.length > 0)
      .sort((a, b) => a.orgName.localeCompare(b.orgName)),
  };
}

export type PlatformUsage = {
  period: UsagePeriod;
  /** Whether rates are configured: without them there is no cost. */
  ratesConfigured: boolean;
  rates: UsageRates;
  organizations: Array<{
    orgId: string;
    orgName: string;
    items: Array<{ kind: UsageKind; quantity: number; cost: number | null }>;
    cost: number | null;
  }>;
  totals: Array<{ kind: UsageKind; unit: string; quantity: number; cost: number | null }>;
  cost: number | null;
  /** The most recent events, for checking and reversing. */
  recent: Array<{
    id: string;
    orgId: string;
    orgName: string;
    actorOrgName: string | null;
    kind: UsageKind;
    quantity: number;
    unit: string;
    occurredAt: string;
    correctionOf: string | null;
    reversed: boolean;
    reason: string | null;
  }>;
};

function costOf(rates: UsageRates, kind: UsageKind, quantity: number): number | null {
  const rate = rates[kind];
  return rate === undefined ? null : Math.round(rate * quantity * 10_000) / 10_000;
}

function sumCosts(costs: Array<number | null>): number | null {
  const known = costs.filter((c): c is number => c !== null);
  return known.length === 0 ? null : Math.round(known.reduce((a, b) => a + b, 0) * 10_000) / 10_000;
}

const RECENT = 50;

/** The platform console: every organization, with the internal cost from the configured rates. */
export async function platformUsage(
  prisma: PrismaClient,
  input: { kind: StatsPeriodKind; previous: boolean; rates: UsageRates; now?: Date },
): Promise<PlatformUsage> {
  const { from, to } = periodBounds(input.kind, input.previous, input.now);
  const where = { occurredAt: { gte: from, lt: to } };
  const [rows, recentRows] = await Promise.all([
    prisma.usageEvent.groupBy({ by: ['tenantId', 'kind'], where, _sum: { quantity: true } }),
    prisma.usageEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: RECENT,
      select: {
        id: true,
        tenantId: true,
        actorOrgId: true,
        kind: true,
        quantity: true,
        unit: true,
        occurredAt: true,
        correctionOf: true,
        reason: true,
        correction: { select: { id: true } },
      },
    }),
  ]);
  const orgIds = new Set<string>(rows.map((r) => r.tenantId));
  for (const r of recentRows) {
    orgIds.add(r.tenantId);
    if (r.actorOrgId) orgIds.add(r.actorOrgId);
  }
  const names = new Map(
    (
      await prisma.tenant.findMany({
        where: { id: { in: [...orgIds] } },
        select: { id: true, name: true },
      })
    ).map((t) => [t.id, t.name]),
  );
  const organizations = [...new Set(rows.map((r) => r.tenantId))]
    .map((orgId) => {
      const items = rows
        .filter((r) => r.tenantId === orgId && (r._sum.quantity ?? 0) !== 0)
        .map((r) => {
          const quantity = r._sum.quantity ?? 0;
          return { kind: r.kind, quantity, cost: costOf(input.rates, r.kind, quantity) };
        })
        .sort((a, b) => USAGE_KINDS.indexOf(a.kind) - USAGE_KINDS.indexOf(b.kind));
      return {
        orgId,
        orgName: names.get(orgId) ?? '—',
        items,
        cost: sumCosts(items.map((i) => i.cost)),
      };
    })
    .filter((o) => o.items.length > 0)
    .sort((a, b) => a.orgName.localeCompare(b.orgName));
  const all = totalsByKind(rows);
  const totals = USAGE_KINDS.map((kind) => {
    const quantity = all.get(kind) ?? 0;
    return { kind, unit: USAGE_UNITS[kind], quantity, cost: costOf(input.rates, kind, quantity) };
  });
  return {
    period: periodView(input.kind, input.previous, from, to),
    ratesConfigured: Object.keys(input.rates).length > 0,
    rates: input.rates,
    organizations,
    totals,
    cost: sumCosts(totals.map((t) => t.cost)),
    recent: recentRows.map((r) => ({
      id: r.id,
      orgId: r.tenantId,
      orgName: names.get(r.tenantId) ?? '—',
      actorOrgName: r.actorOrgId ? (names.get(r.actorOrgId) ?? '—') : null,
      kind: r.kind,
      quantity: r.quantity,
      unit: r.unit,
      occurredAt: r.occurredAt.toISOString(),
      correctionOf: r.correctionOf,
      reversed: r.correction !== null,
      reason: r.reason,
    })),
  };
}

// --- CSV export ---------------------------------------------------------------------------------

/** The names of the kinds in the exported files (Italian, as in the dashboard). */
export const USAGE_LABELS: Record<UsageKind, string> = {
  DOCUMENT_RECEIVED: 'Documenti ricevuti',
  OCR_PAGES: 'Pagine lette con OCR',
  AI_CALL: "Richieste all'assistente",
  AI_TOKENS: "Token dell'assistente",
  PRACTICE_OPENED: 'Pratiche aperte',
  PRACTICE_COMPLETED: 'Pratiche completate',
  DOCUMENT_REQUESTED: 'Documenti richiesti',
  ASSISTANCE_CLOSED: 'Richieste di assistenza chiuse',
};

/** At most this many events in one file: a longer period is exported in parts. */
export const USAGE_EXPORT_MAX_ROWS = 50_000;

export type UsageExport = {
  title: string;
  fileName: string;
  csv: string;
  rows: number;
  /** More events than the file holds. */
  truncated: boolean;
};

const cell = (value: string | number | null): string =>
  value === null
    ? ''
    : typeof value === 'number'
      ? String(value)
      : `"${value.replace(/"/g, '""')}"`;

/** Date and time in Italy, as `2026-11-18 14:05`. */
function italianDateTime(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Rome', hour12: false }).slice(0, 16);
}

/**
 * The usage events of a fixed period as CSV, one row each (reversals included, as negative
 * quantities): of one organization (`tenantId`) or of every organization (the platform, with the
 * internal cost when `rates` are given). Counts and kinds only: never the content of a document.
 */
export async function usageExport(
  prisma: PrismaClient,
  input: {
    tenantId: string | null;
    kind: StatsPeriodKind;
    previous: boolean;
    rates?: UsageRates;
    now?: Date;
  },
): Promise<UsageExport> {
  const { from, to } = periodBounds(input.kind, input.previous, input.now);
  const period = periodView(input.kind, input.previous, from, to);
  const events = await prisma.usageEvent.findMany({
    where: {
      occurredAt: { gte: from, lt: to },
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take: USAGE_EXPORT_MAX_ROWS + 1,
    select: {
      id: true,
      tenantId: true,
      actorOrgId: true,
      kind: true,
      quantity: true,
      unit: true,
      occurredAt: true,
      correctionOf: true,
      reason: true,
    },
  });
  const truncated = events.length > USAGE_EXPORT_MAX_ROWS;
  const rows = events.slice(0, USAGE_EXPORT_MAX_ROWS);
  const orgIds = new Set<string>();
  for (const e of rows) {
    orgIds.add(e.tenantId);
    if (e.actorOrgId) orgIds.add(e.actorOrgId);
  }
  const names = new Map(
    (
      await prisma.tenant.findMany({
        where: { id: { in: [...orgIds] } },
        select: { id: true, name: true },
      })
    ).map((t) => [t.id, t.name]),
  );
  const platform = input.tenantId === null;
  const header = [
    'Data',
    ...(platform ? ['Organizzazione'] : []),
    'Fatto da',
    'Tipo',
    'Quantità',
    'Unità',
    ...(platform ? ['Costo interno (€)'] : []),
    'Rettifica',
    'Motivo',
    'Codice evento',
  ];
  const lines = [header.map(cell).join(',')];
  for (const e of rows) {
    const by = e.actorOrgId
      ? (names.get(e.actorOrgId) ?? '—')
      : platform
        ? (names.get(e.tenantId) ?? '—')
        : 'la tua organizzazione';
    lines.push(
      [
        cell(italianDateTime(e.occurredAt)),
        ...(platform ? [cell(names.get(e.tenantId) ?? '—')] : []),
        cell(by),
        cell(USAGE_LABELS[e.kind]),
        cell(e.quantity),
        cell(e.unit),
        ...(platform ? [cell(costOf(input.rates ?? {}, e.kind, e.quantity))] : []),
        cell(e.correctionOf ? `rettifica di ${e.correctionOf}` : null),
        cell(e.reason),
        cell(e.id),
      ].join(','),
    );
  }
  const span = `${period.from}_${period.to}`;
  return {
    title: `Consumi dal ${period.from.split('-').reverse().join('/')} al ${period.to
      .split('-')
      .reverse()
      .join('/')}`,
    fileName: `${platform ? 'consumi-piattaforma' : 'consumi'}_${span}.csv`,
    // BOM: Excel opens accented letters correctly.
    csv: `\uFEFF${lines.join('\r\n')}\r\n`,
    rows: rows.length,
    truncated,
  };
}

// --- Reversal -----------------------------------------------------------------------------------

export class UsageReversalError extends Error {
  readonly code = 'INVALID_USAGE_REVERSAL';
  constructor(
    message: string,
    readonly statusCode: 400 | 409 = 400,
  ) {
    super(message);
    this.name = 'UsageReversalError';
  }
}

/**
 * Reverses a wrong event with a new one of opposite quantity, with the reason. A reversal cannot
 * be reversed, and an event is reversed once (the unique index on `correction_of` holds it even
 * under two concurrent requests). `audit` writes the trace in the same transaction.
 */
export async function reverseUsageEvent(
  prisma: PrismaClient,
  input: { eventId: string; reason: string; actorUserId: string },
  audit: (tx: PrismaLike, event: { tenantId: string; reversalId: string }) => Promise<void>,
): Promise<{ id: string; correctionOf: string; quantity: number }> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new UsageReversalError('Il motivo deve avere da 3 a 500 caratteri');
  }
  return withTransaction(prisma, async (tx) => {
    const event = await tx.usageEvent.findUnique({
      where: { id: input.eventId },
      select: {
        id: true,
        tenantId: true,
        actorOrgId: true,
        kind: true,
        quantity: true,
        unit: true,
        practiceId: true,
        correctionOf: true,
        correction: { select: { id: true } },
      },
    });
    if (!event) throw new NotFoundError('Usage event not found');
    if (event.correctionOf) {
      throw new UsageReversalError('Uno storno non si può stornare', 409);
    }
    if (event.correction) throw new UsageReversalError('Evento già stornato', 409);
    const created = await tx.usageEvent.createManyAndReturn({
      data: [
        {
          idempotencyKey: `reversal:${event.id}`,
          tenantId: event.tenantId,
          actorOrgId: event.actorOrgId,
          userId: input.actorUserId,
          kind: event.kind,
          quantity: -event.quantity,
          unit: event.unit,
          practiceId: event.practiceId,
          correctionOf: event.id,
          reason,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    const reversal = created[0];
    if (!reversal) throw new UsageReversalError('Evento già stornato', 409);
    await audit(tx, { tenantId: event.tenantId, reversalId: reversal.id });
    return { id: reversal.id, correctionOf: event.id, quantity: -event.quantity };
  });
}
