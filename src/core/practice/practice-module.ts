import { NotFoundError } from '../../data/errors/errors.js';
import { personPracticesWhere } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import {
  getModule,
  moduleAllowsKind,
  practiceTypeOf,
  type PracticeKind,
} from '../../modules/registry.js';
import { fieldsSchema, type VerticalModule } from '../modules/module.contract.js';

import { readPracticePayload } from './practice.payload.js';

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * A02/A04/A05: what the module of an organization decides about its practices — which kinds it
 * may create, which fields they carry and which sub-states they can be in. The common states and
 * their transitions stay the Core's (practice.workflow.ts).
 */

export class PracticeModuleError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: 'KIND_NOT_IN_MODULE' | 'INVALID_FIELDS' | 'INVALID_SUB_STATE',
    message: string,
  ) {
    super(message);
    this.name = 'PracticeModuleError';
  }
}

type TenantModuleReader = { tenant: Pick<PrismaClient['tenant'], 'findUnique'> };

/** The module of an organization (the generic one when the value is unknown). */
export async function moduleOfTenant(
  prisma: TenantModuleReader,
  tenantId: string,
): Promise<VerticalModule> {
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { module: true } });
  if (!row) throw new NotFoundError('Organization not found');
  return getModule(row.module);
}

/**
 * The kind and the fields of a new practice, checked against the module: the module's default
 * kind when none is given, an error for a kind of another module or fields it does not declare.
 */
export function resolvePracticeCreation(
  module: VerticalModule,
  input: { kind?: PracticeKind; fields?: Record<string, unknown> },
): { kind: PracticeKind; fields?: Record<string, unknown> } {
  const kind = (input.kind ?? module.defaultKind) as PracticeKind;
  const type = practiceTypeOf(kind);
  if (!type || !moduleAllowsKind(module, kind)) {
    throw new PracticeModuleError(
      'KIND_NOT_IN_MODULE',
      `Il tipo di pratica «${kind}» non fa parte del modulo ${module.label}`,
    );
  }
  if (input.fields === undefined || Object.keys(input.fields).length === 0) {
    // Required fields are still checked when nothing is given.
    if (type.fields.some((f) => f.required)) {
      const parsed = fieldsSchema(type).safeParse({});
      if (!parsed.success) throw invalidFields(parsed.error.issues);
    }
    return { kind };
  }
  const parsed = fieldsSchema(type).safeParse(input.fields);
  if (!parsed.success) throw invalidFields(parsed.error.issues);
  return { kind, fields: parsed.data };
}

function invalidFields(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) {
  const detail = issues.map((i) => `${i.path.map(String).join('.') || 'fields'}: ${i.message}`);
  return new PracticeModuleError('INVALID_FIELDS', `Campi non validi: ${detail.join('; ')}`);
}

export const PRACTICE_SUB_STATE_CHANGED = 'PRACTICE_SUB_STATE_CHANGED';

/**
 * A05: sets (or clears, with null) the sub-state of a practice. It must be one of its type and
 * allowed in the current common state; the common state itself does not change.
 */
export async function setPracticeSubState(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    practiceId: string;
    subState: string | null;
    actorUserId: string;
    /** "own" grants: only the caller's own practices. */
    ownerUserId?: string;
  },
): Promise<{ subState: string | null }> {
  return withTransaction(prisma, async (tx) => {
    const practice = await tx.practice.findFirst({
      where: {
        id: input.practiceId,
        tenantId: input.tenantId,
        ...(input.ownerUserId ? personPracticesWhere(input.ownerUserId) : {}),
      },
      select: { status: true, payload: true },
    });
    if (!practice) throw new NotFoundError('Practice not found');
    const payload = readPracticePayload(practice.payload);
    if (input.subState !== null) {
      const type =
        payload.kind === 'legacy' || payload.kind === 'unknown'
          ? undefined
          : practiceTypeOf(payload.kind);
      const def = type?.subStates.find((s) => s.key === input.subState);
      if (!def) {
        throw new PracticeModuleError(
          'INVALID_SUB_STATE',
          'Questo sotto-stato non esiste per il tipo di pratica',
        );
      }
      if (!def.during.includes(practice.status)) {
        throw new PracticeModuleError(
          'INVALID_SUB_STATE',
          `«${def.label}» non si può usare nello stato attuale della pratica`,
        );
      }
    }
    if (payload.subState === input.subState) return { subState: input.subState };
    const next = { ...(practice.payload as Record<string, unknown>) };
    if (input.subState === null) delete next.subState;
    else next.subState = input.subState;
    // Like the assignment, only the sub-state changes: not the version of the practice.
    await tx.practice.updateMany({
      where: { id: input.practiceId, tenantId: input.tenantId },
      data: { payload: next as Prisma.InputJsonValue },
    });
    await new AuditService(tx).logEvent({
      tenantId: input.tenantId,
      userId: input.actorUserId,
      eventType: PRACTICE_SUB_STATE_CHANGED,
      payload: {
        practiceId: input.practiceId,
        ...(input.subState ? { subState: input.subState } : { cleared: true }),
      },
    });
    return { subState: input.subState };
  });
}

/** The sub-state to show: only while the common state still allows it (a transition ends it). */
export function visibleSubState(
  payload: ReturnType<typeof readPracticePayload>,
  status: string,
): string | null {
  if (!payload.subState || payload.kind === 'legacy' || payload.kind === 'unknown') return null;
  const def = practiceTypeOf(payload.kind)?.subStates.find((s) => s.key === payload.subState);
  return def && (def.during as readonly string[]).includes(status) ? def.key : null;
}
