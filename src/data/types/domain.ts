import type { PracticeStatus, UserRole } from '@prisma/client';

// Domain-facing DTOs for the Data Layer.
// These types are intentionally stable and independent from transport (HTTP) and business logic (core).

export type TenantDTO = {
  id: string;
  name: string;
  module: string;
  /** A03: functions turned off for the organization. */
  disabledFeatures?: string[];
  integrationType: string;
  schedulerEnabled: boolean;
  schedulerFrequency: string | null;
  schedulerTasks: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type UserDTO = {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  telegramId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PracticeDTO = {
  id: string;
  tenantId: string;
  userId: string;
  status: PracticeStatus;
  version: number;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
  /** A4: who follows the practice (an administrator or operator), if anyone. */
  assignedTo: string | null;
};

export type AuditLogDTO = {
  id: string;
  tenantId: string;
  userId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
};
