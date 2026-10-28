import { NotFoundError } from '../../data/errors/errors.js';
import { ComplianceRepository } from '../../data/repositories/compliance.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { requireDatabase } from '../../runtime/runtime.guard.js';
import { ComplianceValidationError } from '../errors/compliance.errors.js';

import {
  addDays,
  daysUntil,
  parseIsoDate,
  reminderThresholdFor,
  REMINDER_THRESHOLDS,
  todayInRome,
  toIsoDate,
} from './compliance.dates.js';

import type { ComplianceDeadlineDTO } from '../../data/repositories/compliance.repository.js';
import type { ComplianceCategory, ComplianceDeadlineStatus, PrismaClient } from '@prisma/client';

export const COMPLIANCE_CATEGORIES = [
  'DURC',
  'SICUREZZA_LAVORO',
  'CERTIFICAZIONE_BIO',
  'VISITA_MEDICA',
  'PATENTINO',
  'ALTRO',
] as const satisfies readonly ComplianceCategory[];

export const COMPLIANCE_CATEGORY_LABELS: Record<ComplianceCategory, string> = {
  DURC: 'DURC',
  SICUREZZA_LAVORO: 'Formazione sicurezza sul lavoro',
  CERTIFICAZIONE_BIO: 'Certificazione biologica',
  VISITA_MEDICA: 'Visita medica',
  PATENTINO: 'Patentino',
  ALTRO: 'Altro',
};

export const COMPLIANCE_DEADLINE_REMINDER = 'COMPLIANCE_DEADLINE_REMINDER';

/** Outbox payload of a reminder; the dispatcher turns it into Telegram and webhook messages. */
export type ComplianceReminderPayload = {
  deadlineId: string;
  category: ComplianceCategory;
  title: string;
  dueDate: string;
  daysLeft: number;
  thresholdDays: number;
  userId: string | null;
};

export type ComplianceDeadlineView = {
  id: string;
  shortId: string;
  category: ComplianceCategory;
  title: string;
  dueDate: string;
  daysLeft: number;
  status: ComplianceDeadlineStatus;
  userId: string | null;
  notes: string | null;
  closedAt: string | null;
  createdAt: string;
};

const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;
const SHORT_ID_LENGTH = 8;

export function toDeadlineView(row: ComplianceDeadlineDTO, today: string): ComplianceDeadlineView {
  return {
    id: row.id,
    shortId: row.id.slice(0, SHORT_ID_LENGTH),
    category: row.category,
    title: row.title,
    dueDate: toIsoDate(row.dueDate),
    daysLeft: daysUntil(row.dueDate, today),
    status: row.status,
    userId: row.userId,
    notes: row.notes,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Compliance deadlines of a cooperative (DURC, safety training, organic certification, medical
 * checks, licences) and their reminders at 30/15/7/1 days and on the due date.
 */
export class ComplianceService {
  private readonly repository: ComplianceRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.repository = new ComplianceRepository(prisma);
  }

  async createDeadline(input: {
    tenantId: string;
    createdBy: string;
    userId?: string | null;
    category: string;
    title: string;
    dueDate: string;
    notes?: string | null;
  }): Promise<ComplianceDeadlineView> {
    requireDatabase();
    const category = input.category.toUpperCase() as ComplianceCategory;
    if (!COMPLIANCE_CATEGORIES.includes(category)) {
      throw new ComplianceValidationError(
        `Unknown category: allowed values are ${COMPLIANCE_CATEGORIES.join(', ')}`,
      );
    }
    const title = input.title.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new ComplianceValidationError(`Title must be 1-${MAX_TITLE_LENGTH} characters`);
    }
    const dueDate = parseIsoDate(input.dueDate);
    if (!dueDate) {
      throw new ComplianceValidationError('dueDate must be a valid date (YYYY-MM-DD)');
    }
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > MAX_NOTES_LENGTH) {
      throw new ComplianceValidationError(`Notes must be at most ${MAX_NOTES_LENGTH} characters`);
    }

    const created = await withTransaction(this.prisma, async (tx) => {
      const row = await new ComplianceRepository(tx).create({
        tenantId: input.tenantId,
        createdBy: input.createdBy,
        userId: input.userId ?? null,
        category,
        title,
        dueDate,
        notes,
      });
      await new AuditService(tx).logEvent({
        tenantId: input.tenantId,
        userId: input.createdBy,
        eventType: 'COMPLIANCE_DEADLINE_CREATED',
        payload: { deadlineId: row.id, category, dueDate: input.dueDate },
      });
      return row;
    });

    // A deadline created close to its due date is reminded now, not at the next daily run.
    await this.sendDueReminders({ deadlineId: created.id, tenantId: input.tenantId });
    return toDeadlineView(created, todayInRome(this.clock()));
  }

  async listDeadlines(input: {
    tenantId: string;
    status?: ComplianceDeadlineStatus;
    category?: ComplianceCategory;
    userId?: string;
    withinDays?: number;
    limit?: number;
  }): Promise<ComplianceDeadlineView[]> {
    requireDatabase();
    const today = todayInRome(this.clock());
    const rows = await this.repository.list(input.tenantId, {
      status: input.status,
      category: input.category,
      userId: input.userId,
      limit: input.limit,
      ...(input.withinDays !== undefined
        ? { dueBefore: addDays(parseIsoDate(today)!, input.withinDays) }
        : {}),
    });
    return rows.map((row) => toDeadlineView(row, today));
  }

  /**
   * Closes a deadline (renewed, handled). `idOrPrefix` is a full id or the short code shown on
   * Telegram. `userId` restricts the lookup to that member's deadlines.
   */
  async closeDeadline(input: {
    tenantId: string;
    idOrPrefix: string;
    closedBy: string;
    userId?: string;
  }): Promise<ComplianceDeadlineView> {
    requireDatabase();
    const id = await this.resolveId(input.tenantId, input.idOrPrefix);
    const existing = await this.repository.getById(input.tenantId, id);
    if (input.userId && existing.userId !== input.userId) {
      throw new NotFoundError('Compliance deadline not found');
    }

    const now = this.clock();
    const closed = await withTransaction(this.prisma, async (tx) => {
      const row = await new ComplianceRepository(tx).close(input.tenantId, id, now);
      if (existing.status === 'OPEN') {
        await new AuditService(tx).logEvent({
          tenantId: input.tenantId,
          userId: input.closedBy,
          eventType: 'COMPLIANCE_DEADLINE_CLOSED',
          payload: { deadlineId: id },
        });
      }
      return row;
    });
    return toDeadlineView(closed, todayInRome(now));
  }

  /**
   * Enqueues the reminders due today: for every open deadline within 30 days, the tightest
   * threshold reached (30, 15, 7, 1, or 0 on/after the due date). Safe to run any number of times
   * and from several workers: each (deadline, threshold) reminder is created once.
   */
  async sendDueReminders(
    options: { tenantId?: string; deadlineId?: string; now?: Date } = {},
  ): Promise<{ checked: number; enqueued: number; alreadySent: number }> {
    const { now, ...filter } = options;
    const today = todayInRome(now ?? this.clock());
    const horizon = addDays(parseIsoDate(today)!, REMINDER_THRESHOLDS[0]);
    const due = await this.repository.findDueOpen({ dueBefore: horizon, ...filter });

    let enqueued = 0;
    let alreadySent = 0;
    for (const deadline of due) {
      const daysLeft = daysUntil(deadline.dueDate, today);
      const thresholdDays = reminderThresholdFor(daysLeft);
      if (thresholdDays === null) continue;

      const payload: ComplianceReminderPayload = {
        deadlineId: deadline.id,
        category: deadline.category,
        title: deadline.title,
        dueDate: toIsoDate(deadline.dueDate),
        daysLeft,
        thresholdDays,
        userId: deadline.userId,
      };
      const created = await this.repository.createReminderOnce({
        tenantId: deadline.tenantId,
        deadlineId: deadline.id,
        thresholdDays,
        eventType: COMPLIANCE_DEADLINE_REMINDER,
        payload,
      });
      if (created) enqueued++;
      else alreadySent++;
    }
    return { checked: due.length, enqueued, alreadySent };
  }

  private async resolveId(tenantId: string, idOrPrefix: string): Promise<string> {
    const value = idOrPrefix.trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return value;
    if (!/^[0-9a-f]{6,}$/.test(value)) {
      throw new NotFoundError('Compliance deadline not found');
    }
    const ids = await this.repository.findIdsByPrefix(tenantId, value);
    if (ids.length !== 1 || !ids[0]) {
      throw new NotFoundError('Compliance deadline not found');
    }
    return ids[0];
  }
}
