import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import { REMINDER_THRESHOLDS } from '../compliance/compliance.dates.js';

import type { SchedulerFrequency } from '../tenant/tenant.store.js';
import type { OrganizationType, PrismaClient } from '@prisma/client';

/**
 * Settings an administrator manages from the dashboard (P12, docs/PROGETTO_FRONTEND_V2.md §3):
 * the name and the scheduled export of the organization. The type is shown but changed only by
 * the platform; deadline reminders are always on, with fixed thresholds.
 */

export const FREQUENCIES: readonly SchedulerFrequency[] = ['daily', 'weekly', 'monthly'];

export type OrganizationSettings = {
  id: string;
  name: string;
  type: OrganizationType;
  scheduledExport: { enabled: boolean; frequency: SchedulerFrequency };
  reminderDays: number[];
};

export type OrganizationSettingsChange = {
  name?: string;
  scheduledExport?: { enabled: boolean; frequency?: SchedulerFrequency };
};

export class OrganizationSettingsError extends Error {
  readonly statusCode = 400;
  readonly code = 'ORGANIZATION_SETTINGS_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationSettingsError';
  }
}

function frequencyOf(value: string | null): SchedulerFrequency {
  return FREQUENCIES.includes(value as SchedulerFrequency)
    ? (value as SchedulerFrequency)
    : 'monthly';
}

export async function getOrganizationSettings(
  prisma: PrismaClient,
  orgId: string,
): Promise<OrganizationSettings> {
  const row = await prisma.tenant.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      type: true,
      schedulerEnabled: true,
      schedulerFrequency: true,
    },
  });
  if (!row) throw new NotFoundError('Organization not found');
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    scheduledExport: {
      enabled: row.schedulerEnabled,
      frequency: frequencyOf(row.schedulerFrequency),
    },
    reminderDays: REMINDER_THRESHOLDS.filter((d) => d > 0),
  };
}

/** Applies the changes and records what changed (values, never who receives the export). */
export async function updateOrganizationSettings(
  prisma: PrismaClient,
  orgId: string,
  change: OrganizationSettingsChange,
  actor: { userId: string },
): Promise<OrganizationSettings> {
  const name = change.name?.trim().replace(/\s+/g, ' ');
  if (name !== undefined && (name.length < 2 || name.length > 120)) {
    throw new OrganizationSettingsError('Il nome deve avere da 2 a 120 caratteri');
  }
  await withTransaction(prisma, async (tx) => {
    const current = await tx.tenant.findUnique({
      where: { id: orgId },
      select: { name: true, schedulerEnabled: true, schedulerFrequency: true },
    });
    if (!current) throw new NotFoundError('Organization not found');
    const data: { name?: string; schedulerEnabled?: boolean; schedulerFrequency?: string } = {};
    const changed: Record<string, string | boolean> = {};
    if (name !== undefined && name !== current.name) {
      data.name = name;
      changed.name = name;
    }
    const exportChange = change.scheduledExport;
    if (exportChange) {
      if (exportChange.enabled !== current.schedulerEnabled) {
        data.schedulerEnabled = exportChange.enabled;
        changed.scheduledExport = exportChange.enabled;
      }
      const frequency = exportChange.frequency;
      if (frequency && frequency !== frequencyOf(current.schedulerFrequency)) {
        data.schedulerFrequency = frequency;
        changed.frequency = frequency;
      }
    }
    if (Object.keys(changed).length === 0) return;
    await tx.tenant.update({ where: { id: orgId }, data });
    await new AuditService(tx).logEvent({
      tenantId: orgId,
      userId: actor.userId,
      eventType: 'ORGANIZATION_SETTINGS_CHANGED',
      payload: changed,
    });
  });
  return getOrganizationSettings(prisma, orgId);
}
