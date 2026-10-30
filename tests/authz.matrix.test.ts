/**
 * Expected permissions per role, declared here independently of src/core/authz/permissions.ts:
 * an accidental change to the catalog fails this test. Rules still to be decided stay as todo
 * (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md, §3.3-§3.5).
 */
import { describe, expect, it } from 'vitest';

import {
  authorize,
  can,
  PermissionDeniedError,
  scopedUserId,
} from '../src/core/authz/authorization.service.js';
import { PERMISSIONS, type Permission } from '../src/core/authz/permissions.js';

import type { UserRole } from '@prisma/client';

type Expected = 'tenant' | 'own' | 'denied';

const EXPECTED: Record<Permission, Record<UserRole, Expected>> = {
  'practice.create': { ADMIN: 'own', OPERATOR: 'own', MEMBER: 'own' },
  'practice.read': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'own' },
  'practice.export': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'own' },
  'practice.transition': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'denied' },
  'practice.delete': { ADMIN: 'own', OPERATOR: 'own', MEMBER: 'own' },
  'attachment.create': { ADMIN: 'own', OPERATOR: 'own', MEMBER: 'own' },
  'attachment.read': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'own' },
  'ai.execute': { ADMIN: 'own', OPERATOR: 'own', MEMBER: 'own' },
  'ai.traces.read': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'denied' },
  'compliance.read': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'own' },
  'compliance.manage': { ADMIN: 'tenant', OPERATOR: 'tenant', MEMBER: 'denied' },
  'audit.read': { ADMIN: 'tenant', OPERATOR: 'denied', MEMBER: 'denied' },
  'members.read': { ADMIN: 'tenant', OPERATOR: 'denied', MEMBER: 'denied' },
  'members.manage': { ADMIN: 'tenant', OPERATOR: 'denied', MEMBER: 'denied' },
};

const ROLES: UserRole[] = ['ADMIN', 'OPERATOR', 'MEMBER'];
const principal = (role: UserRole) => ({ tenantId: 't-1', userId: 'u-1', role });

describe('permission matrix', () => {
  it('declares an expectation for every permission of the catalog', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  for (const permission of PERMISSIONS) {
    for (const role of ROLES) {
      const expected = EXPECTED[permission][role];
      it(`${role} → ${permission}: ${expected}`, () => {
        if (expected === 'denied') {
          expect(can(role, permission)).toBe(false);
          expect(() => authorize(principal(role), permission)).toThrow(PermissionDeniedError);
          return;
        }
        expect(can(role, permission)).toBe(true);
        const grant = authorize(principal(role), permission);
        expect(grant.scope).toBe(expected);
        // Own grants always filter by the caller, whatever the request asks for.
        expect(scopedUserId(grant, 'u-other')).toBe(expected === 'own' ? 'u-1' : 'u-other');
      });
    }
  }

  it('denies with a message the chat channels turn into the Italian reply', () => {
    expect(() => authorize(principal('MEMBER'), 'practice.transition')).toThrow(
      /^PERMISSION_DENIED/,
    );
  });

  // Decisions still open: the expectations above describe today's behaviour for these cases.
  // C2 is decided and covered by tests/mf2b.chat-view.test.ts.
  it.todo('C3: deletion only by ORG_ADMIN, with confirmation, per rules R1-R13 (§3.5)');
  it.todo('D5: OPERATOR exports the whole organization only with an extra permission (§3.3)');
});
