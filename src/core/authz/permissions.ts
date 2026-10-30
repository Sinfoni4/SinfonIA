import type { UserRole } from '@prisma/client';

/**
 * Permission catalog: the only place that says what each role may do.
 *
 * It mirrors the behaviour before the central authorization service
 * (tests/authz.characterization.test.ts). Rules still to be decided are marked:
 * C2 (default view in chat) and C3 (deletion), see docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md.
 */

export const PERMISSIONS = [
  'practice.create',
  'practice.read',
  'practice.export',
  'practice.transition',
  'practice.delete',
  'attachment.create',
  'attachment.read',
  'ai.execute',
  'ai.traces.read',
  'compliance.read',
  'compliance.manage',
  'audit.read',
  'members.read',
  'members.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Objects a granted permission reaches: the caller's own ones, or the whole tenant. */
export type PermissionScope = 'own' | 'tenant';

const STAFF: Partial<Record<Permission, PermissionScope>> = {
  'practice.create': 'own',
  'practice.read': 'tenant',
  'practice.export': 'tenant',
  'practice.transition': 'tenant',
  // C3 pending: today any role deletes its own practices from chat, without confirmation.
  'practice.delete': 'own',
  // Attachments go only to the uploader's own practices, whatever the role.
  'attachment.create': 'own',
  'attachment.read': 'tenant',
  // The AI works on the caller's own practices, whatever the role.
  'ai.execute': 'own',
  'ai.traces.read': 'tenant',
  'compliance.read': 'tenant',
  'compliance.manage': 'tenant',
};

export const ROLE_PERMISSIONS: Record<UserRole, Partial<Record<Permission, PermissionScope>>> = {
  ADMIN: { ...STAFF, 'audit.read': 'tenant', 'members.read': 'tenant', 'members.manage': 'tenant' },
  OPERATOR: STAFF,
  MEMBER: {
    'practice.create': 'own',
    'practice.read': 'own',
    'practice.export': 'own',
    'practice.delete': 'own',
    'attachment.create': 'own',
    'attachment.read': 'own',
    'ai.execute': 'own',
    'compliance.read': 'own',
  },
};
