import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import type { PrismaLike } from '../../data/types/prisma.js';
import type {
  BeneficiaryStatus,
  GranteeType,
  GrantOperation,
  GrantStatus,
  OrganizationType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

/**
 * MF8 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2.4, decision D3): an organization lets a person
 * (e.g. a consultant) or another organization (e.g. its network) work on its practices, only for
 * the chosen operations and until a date.
 *
 * D3 rules: an end date is mandatory, at most 12 months away, 3 months when the delegation
 * includes DELETE or EXPORT; renewal only by an explicit choice of the grantor, never automatic;
 * revocation at once. A delegation to an organization applies only to the people of a named list
 * proposed by that organization and approved by the grantor; a new member gets nothing.
 */

/** Operations available in this version; the others are refused until their rules exist. */
export const AVAILABLE_OPERATIONS: readonly GrantOperation[] = ['READ', 'UPDATE', 'EXPORT'];
/** Operations that shorten the maximum duration to 3 months (D3.7). */
const SENSITIVE: readonly GrantOperation[] = ['DELETE', 'EXPORT'];
const MAX_MONTHS = 12;
const MAX_MONTHS_SENSITIVE = 3;
const DAY_MS = 24 * 60 * 60_000;

export class DelegationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 409 = 400,
    readonly code = 'DELEGATION_INVALID',
  ) {
    super(message);
    this.name = 'DelegationError';
  }
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** The latest end date allowed for these operations, from `now` (D3.1, D3.7). */
export function maxValidUntil(operations: readonly GrantOperation[], now = new Date()): Date {
  const sensitive = operations.some((o) => SENSITIVE.includes(o));
  return addMonths(now, sensitive ? MAX_MONTHS_SENSITIVE : MAX_MONTHS);
}

/** Checks operations and end date against D3; returns the operations without duplicates. */
export function checkDelegation(
  operations: readonly GrantOperation[],
  validUntil: Date,
  now = new Date(),
): GrantOperation[] {
  const ops = [...new Set(operations)];
  if (ops.length === 0) throw new DelegationError('Scegli almeno un’operazione');
  const unavailable = ops.filter((o) => !AVAILABLE_OPERATIONS.includes(o));
  if (unavailable.length > 0) {
    throw new DelegationError(`Operazioni non ancora disponibili: ${unavailable.join(', ')}`);
  }
  if (!ops.includes('READ')) {
    throw new DelegationError('Una delega comprende sempre la lettura (READ)');
  }
  if (Number.isNaN(validUntil.getTime()) || validUntil.getTime() < now.getTime() + DAY_MS) {
    throw new DelegationError('La scadenza deve essere almeno di domani');
  }
  if (validUntil > maxValidUntil(ops, now)) {
    throw new DelegationError(
      ops.some((o) => SENSITIVE.includes(o))
        ? 'Con l’export la delega dura al massimo 3 mesi'
        : 'Una delega dura al massimo 12 mesi',
    );
  }
  return ops;
}

/** The state shown to people: a delegation past its end date is «expired» (D3.5). */
export type GrantState = 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED';

export function grantState(
  g: { status: GrantStatus; validUntil: Date },
  now = new Date(),
): GrantState {
  if (g.status !== 'ACTIVE') return g.status;
  return g.validUntil <= now ? 'EXPIRED' : 'ACTIVE';
}

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;
const emailOf = (email: string) => (PLACEHOLDER_EMAIL.test(email) ? null : email);

export type IssuedGrant = {
  id: string;
  granteeType: GranteeType;
  grantee: { orgId?: string; name: string; type?: OrganizationType };
  operations: GrantOperation[];
  validFrom: Date;
  validUntil: Date;
  state: GrantState;
  revokedAt: Date | null;
  beneficiaries: Array<{ userId: string; email: string | null; status: BeneficiaryStatus }>;
};

const GRANT_SELECT = {
  id: true,
  grantorOrgId: true,
  granteeType: true,
  granteeOrgId: true,
  granteeUserId: true,
  operations: true,
  validFrom: true,
  validUntil: true,
  status: true,
  revokedAt: true,
  grantor: { select: { id: true, name: true } },
  granteeOrg: { select: { id: true, name: true, type: true } },
  granteeUser: { select: { email: true } },
  beneficiaries: {
    orderBy: { createdAt: 'asc' as const },
    select: { userId: true, status: true, user: { select: { email: true } } },
  },
} satisfies Prisma.AccessGrantSelect;

type GrantRow = Prisma.AccessGrantGetPayload<{ select: typeof GRANT_SELECT }>;

function toIssued(g: GrantRow, now: Date): IssuedGrant {
  return {
    id: g.id,
    granteeType: g.granteeType,
    grantee: g.granteeOrg
      ? { orgId: g.granteeOrg.id, name: g.granteeOrg.name, type: g.granteeOrg.type }
      : { name: emailOf(g.granteeUser?.email ?? '') ?? 'persona senza email' },
    operations: g.operations,
    validFrom: g.validFrom,
    validUntil: g.validUntil,
    state: grantState(g, now),
    revokedAt: g.revokedAt,
    beneficiaries: g.beneficiaries.map((b) => ({
      userId: b.userId,
      email: emailOf(b.user.email),
      status: b.status,
    })),
  };
}

/** The delegations an organization gave, newest first. */
export async function listIssuedGrants(
  prisma: PrismaClient,
  grantorOrgId: string,
): Promise<IssuedGrant[]> {
  const now = new Date();
  const rows = await prisma.accessGrant.findMany({
    where: { grantorOrgId },
    orderBy: { createdAt: 'desc' },
    select: GRANT_SELECT,
  });
  return rows.map((g) => toIssued(g, now));
}

export type GranteeInput = { orgId: string } | { email: string };

export async function issueGrant(
  prisma: PrismaClient,
  input: {
    grantorOrgId: string;
    actorUserId: string;
    grantee: GranteeInput;
    operations: GrantOperation[];
    validUntil: Date;
  },
): Promise<{ id: string }> {
  const operations = checkDelegation(input.operations, input.validUntil);
  return withTransaction(prisma, async (tx) => {
    const grantor = await tx.tenant.findUniqueOrThrow({
      where: { id: input.grantorOrgId },
      select: { name: true },
    });
    let grantee: { granteeType: GranteeType; granteeOrgId?: string; granteeUserId?: string };
    let granteeName: string;
    if ('orgId' in input.grantee) {
      if (input.grantee.orgId === input.grantorOrgId) {
        throw new DelegationError('Un’organizzazione non può delegare sé stessa');
      }
      const org = await tx.tenant.findUnique({
        where: { id: input.grantee.orgId },
        select: { id: true, name: true, status: true },
      });
      if (!org || org.status !== 'ACTIVE') {
        throw new DelegationError('Codice dell’organizzazione non valido', 400, 'UNKNOWN_GRANTEE');
      }
      grantee = { granteeType: 'ORGANIZATION', granteeOrgId: org.id };
      granteeName = org.name;
    } else {
      const email = input.grantee.email.trim().toLowerCase();
      const user = await tx.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!user) {
        throw new DelegationError(
          'Nessun account attivo con questa email: la persona deve prima avere un accesso a SinfonIA',
          400,
          'UNKNOWN_GRANTEE',
        );
      }
      if (user.id === input.actorUserId) {
        throw new DelegationError('Non puoi concedere una delega a te stesso');
      }
      grantee = { granteeType: 'USER', granteeUserId: user.id };
      granteeName = email;
    }
    const grant = await tx.accessGrant.create({
      data: {
        grantorOrgId: input.grantorOrgId,
        ...grantee,
        scope: { types: ['practices'] },
        operations,
        validUntil: input.validUntil,
        createdBy: input.actorUserId,
      },
      select: { id: true },
    });
    const audit = new AuditService(tx);
    await audit.logEvent({
      tenantId: input.grantorOrgId,
      userId: input.actorUserId,
      eventType: 'GRANT_ISSUED',
      payload: {
        grantId: grant.id,
        organization: granteeName,
        operations: operations.join(','),
        dueDate: input.validUntil.toISOString().slice(0, 10),
      },
    });
    if (grantee.granteeOrgId) {
      await audit.logEvent({
        tenantId: grantee.granteeOrgId,
        userId: null,
        eventType: 'GRANT_RECEIVED',
        payload: {
          grantId: grant.id,
          organization: grantor.name,
          operations: operations.join(','),
          dueDate: input.validUntil.toISOString().slice(0, 10),
        },
      });
    }
    return grant;
  });
}

async function grantOfGrantor(db: PrismaLike, grantId: string, grantorOrgId: string) {
  const grant = await db.accessGrant.findFirst({
    where: { id: grantId, grantorOrgId },
    select: {
      id: true,
      status: true,
      operations: true,
      validUntil: true,
      granteeType: true,
      granteeOrgId: true,
      granteeOrg: { select: { name: true } },
      granteeUser: { select: { email: true } },
    },
  });
  if (!grant) throw new NotFoundError('Delegation not found');
  return grant;
}

/** D3.3: the grantor renews explicitly; the new end date counts from today. */
export async function renewGrant(
  prisma: PrismaClient,
  input: { grantId: string; grantorOrgId: string; actorUserId: string; validUntil: Date },
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const grant = await grantOfGrantor(tx, input.grantId, input.grantorOrgId);
    if (grant.status === 'REVOKED') {
      throw new DelegationError('Una delega revocata non si rinnova: creane una nuova', 409);
    }
    checkDelegation(grant.operations, input.validUntil);
    await tx.accessGrant.update({
      where: { id: grant.id },
      data: { validUntil: input.validUntil, reminded30At: null, reminded7At: null },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.grantorOrgId,
      userId: input.actorUserId,
      eventType: 'GRANT_RENEWED',
      payload: { grantId: grant.id, dueDate: input.validUntil.toISOString().slice(0, 10) },
    });
  });
}

/** D3.6: revocation at once, recorded on both sides. */
export async function revokeGrant(
  prisma: PrismaClient,
  input: { grantId: string; grantorOrgId: string; actorUserId: string; reason?: string },
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const grant = await grantOfGrantor(tx, input.grantId, input.grantorOrgId);
    if (grant.status === 'REVOKED') throw new DelegationError('La delega è già revocata', 409);
    const grantor = await tx.tenant.findUniqueOrThrow({
      where: { id: input.grantorOrgId },
      select: { name: true },
    });
    await tx.accessGrant.update({
      where: { id: grant.id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: input.actorUserId,
        revocationReason: input.reason?.trim().slice(0, 500) || null,
      },
    });
    const audit = new AuditService(tx);
    await audit.logEvent({
      tenantId: input.grantorOrgId,
      userId: input.actorUserId,
      eventType: 'GRANT_REVOKED',
      payload: { grantId: grant.id },
    });
    if (grant.granteeOrgId) {
      await audit.logEvent({
        tenantId: grant.granteeOrgId,
        userId: null,
        eventType: 'GRANT_REVOKED',
        payload: { grantId: grant.id, organization: grantor.name },
      });
    }
  });
}

/** The grantor approves or removes a person named by the organization that received the delegation. */
export async function setBeneficiary(
  prisma: PrismaClient,
  input: {
    grantId: string;
    grantorOrgId: string;
    actorUserId: string;
    userId: string;
    approve: boolean;
  },
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const grant = await grantOfGrantor(tx, input.grantId, input.grantorOrgId);
    if (grant.granteeType !== 'ORGANIZATION') {
      throw new DelegationError('Solo le deleghe a un’organizzazione hanno beneficiari');
    }
    const row = await tx.accessGrantBeneficiary.findUnique({
      where: { grantId_userId: { grantId: grant.id, userId: input.userId } },
      select: { status: true },
    });
    if (!row) throw new NotFoundError('Beneficiary not found');
    const updated = await tx.accessGrantBeneficiary.updateMany({
      where: {
        grantId: grant.id,
        userId: input.userId,
        status: input.approve ? 'PROPOSED' : { in: ['PROPOSED', 'ACTIVE'] },
      },
      data: input.approve
        ? { status: 'ACTIVE', approvedBy: input.actorUserId, approvedAt: new Date() }
        : { status: 'REVOKED', revokedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new DelegationError('Il beneficiario è già cambiato: ricarica la pagina', 409);
    }
    await new AuditService(tx).logEvent({
      tenantId: input.grantorOrgId,
      userId: input.actorUserId,
      eventType: input.approve ? 'GRANT_BENEFICIARY_APPROVED' : 'GRANT_BENEFICIARY_REMOVED',
      payload: { grantId: grant.id, targetUserId: input.userId },
    });
  });
}

export type ReceivedGrant = {
  id: string;
  grantor: { orgId: string; name: string };
  granteeType: GranteeType;
  operations: GrantOperation[];
  validUntil: Date;
  state: GrantState;
  /** Whether the person asking can use it now. */
  usable: boolean;
  /** For a delegation to an organization: its named people. */
  beneficiaries: Array<{ userId: string; email: string | null; status: BeneficiaryStatus }>;
};

/** The delegations the person can see: to them, or to the organization they work for now. */
export async function listReceivedGrants(
  prisma: PrismaClient,
  input: { userId: string; orgId: string },
): Promise<ReceivedGrant[]> {
  const now = new Date();
  const rows = await prisma.accessGrant.findMany({
    where: {
      status: { not: 'REVOKED' },
      OR: [{ granteeUserId: input.userId }, { granteeOrgId: input.orgId }],
    },
    orderBy: { validUntil: 'asc' },
    select: GRANT_SELECT,
  });
  return rows.map((g) => {
    const state = grantState(g, now);
    const mine = g.beneficiaries.find((b) => b.userId === input.userId);
    const usable =
      state === 'ACTIVE' &&
      (g.granteeUserId === input.userId ||
        (g.granteeOrgId === input.orgId && mine?.status === 'ACTIVE'));
    return {
      id: g.id,
      grantor: { orgId: g.grantor.id, name: g.grantor.name },
      granteeType: g.granteeType,
      operations: g.operations,
      validUntil: g.validUntil,
      state,
      usable,
      beneficiaries: g.beneficiaries.map((b) => ({
        userId: b.userId,
        email: emailOf(b.user.email),
        status: b.status,
      })),
    };
  });
}

/**
 * An administrator of the organization that received a delegation names one of its active members
 * as a beneficiary; the grantor still has to approve (§2.4, point 2).
 */
export async function proposeBeneficiary(
  prisma: PrismaClient,
  input: { grantId: string; granteeOrgId: string; actorUserId: string; userId: string },
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const grant = await tx.accessGrant.findFirst({
      where: { id: input.grantId, granteeOrgId: input.granteeOrgId, status: { not: 'REVOKED' } },
      select: { id: true, grantorOrgId: true, granteeOrg: { select: { name: true } } },
    });
    if (!grant) throw new NotFoundError('Delegation not found');
    const member = await tx.membership.findFirst({
      where: {
        orgId: input.granteeOrgId,
        userId: input.userId,
        status: 'ACTIVE',
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!member) {
      throw new DelegationError('La persona deve essere un membro attivo della tua organizzazione');
    }
    const existing = await tx.accessGrantBeneficiary.findUnique({
      where: { grantId_userId: { grantId: grant.id, userId: input.userId } },
      select: { status: true },
    });
    if (existing && existing.status !== 'REVOKED') {
      throw new DelegationError('Persona già proposta', 409);
    }
    const data = {
      status: 'PROPOSED' as const,
      proposedBy: input.actorUserId,
      approvedBy: null,
      approvedAt: null,
      revokedAt: null,
    };
    if (existing) {
      await tx.accessGrantBeneficiary.update({
        where: { grantId_userId: { grantId: grant.id, userId: input.userId } },
        data,
      });
    } else {
      await tx.accessGrantBeneficiary.create({
        data: { grantId: grant.id, userId: input.userId, ...data },
      });
    }
    const audit = new AuditService(tx);
    await audit.logEvent({
      tenantId: input.granteeOrgId,
      userId: input.actorUserId,
      eventType: 'GRANT_BENEFICIARY_PROPOSED',
      payload: { grantId: grant.id, targetUserId: input.userId },
    });
    await audit.logEvent({
      tenantId: grant.grantorOrgId,
      userId: null,
      eventType: 'GRANT_BENEFICIARY_PROPOSED',
      payload: { grantId: grant.id, organization: grant.granteeOrg?.name ?? null },
    });
  });
}

export type DelegatedAccess = {
  grantId: string;
  grantorOrgId: string;
  grantorName: string;
  operations: GrantOperation[];
  validUntil: Date;
};

/**
 * Whether the person may do `operation` through the delegation now (§2.4, point 5): delegation
 * active and not expired, organization of the grantor active, operation included; for a
 * delegation to a person, that person; for one to an organization, an approved and active
 * beneficiary who works now for that organization. Anything else looks like a missing delegation.
 */
export async function resolveDelegatedAccess(
  prisma: PrismaLike,
  input: { grantId: string; userId: string; currentOrgId: string; operation: GrantOperation },
): Promise<DelegatedAccess> {
  const now = new Date();
  const grant = await prisma.accessGrant.findFirst({
    where: {
      id: input.grantId,
      status: 'ACTIVE',
      validFrom: { lte: now },
      validUntil: { gt: now },
      grantor: { status: 'ACTIVE' },
      OR: [
        { granteeType: 'USER', granteeUserId: input.userId, granteeUser: { status: 'ACTIVE' } },
        {
          granteeType: 'ORGANIZATION',
          granteeOrgId: input.currentOrgId,
          beneficiaries: {
            some: { userId: input.userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
          },
        },
      ],
    },
    select: {
      id: true,
      grantorOrgId: true,
      operations: true,
      validUntil: true,
      grantor: { select: { name: true } },
    },
  });
  if (!grant) throw new NotFoundError('Delegation not found');
  if (!grant.operations.includes(input.operation)) {
    throw new DelegationError(
      'Questa operazione non è compresa nella delega',
      403,
      'OPERATION_NOT_DELEGATED',
    );
  }
  return {
    grantId: grant.id,
    grantorOrgId: grant.grantorOrgId,
    grantorName: grant.grantor.name,
    operations: grant.operations,
    validUntil: grant.validUntil,
  };
}

/** Records a use of a delegation in the log of the organization that gave it. */
export async function auditDelegatedUse(
  prisma: PrismaLike,
  access: DelegatedAccess,
  userId: string,
  action: string,
  extra: Record<string, string> = {},
): Promise<void> {
  await new AuditService(prisma).logEvent({
    tenantId: access.grantorOrgId,
    userId,
    eventType: 'DELEGATED_ACCESS',
    payload: { grantId: access.grantId, action, ...extra },
  });
}

/** Days left, rounded up, for the reminders. */
export function daysLeft(validUntil: Date, now = new Date()): number {
  return Math.ceil((validUntil.getTime() - now.getTime()) / DAY_MS);
}
