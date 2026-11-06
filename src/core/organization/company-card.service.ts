import { personPracticesWhere } from '../../data/repositories/practice.repository.js';
import { AuditService } from '../../data/services/audit.service.js';
import {
  authorize,
  PermissionDeniedError,
  permits,
  practiceReach,
} from '../authz/authorization.service.js';
import { FeatureDisabledError } from '../features/features.js';

import type { Principal } from '../authz/authorization.service.js';
import type { ComplianceService } from '../compliance/compliance.service.js';
import type { OrganizationType, PracticeStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * AGX-12a: the card of the company in chat («🏢 La mia azienda»), read only.
 *
 * - Everyone sees name, type, municipality, sector, their role and the networks of the company.
 * - Practices and deadlines are counted within the person's own grants, as in the dashboard home.
 * - Codice fiscale / CUAA and partita IVA only reach who manages the organization
 *   (`organization.manage`), masked; the full codes are a separate request, recorded in the audit
 *   without their values. The codes in other systems never go to the chat.
 */

const CLOSED: PracticeStatus[] = ['COMPLETED', 'FAILED'];

export type CompanyCard = {
  name: string;
  type: OrganizationType;
  municipality: string | null;
  sector: string | null;
  /** Active networks the company belongs to (names only). */
  networks: string[];
  /** Open practices within the person's grants; null without `practice.read`. */
  openPractices: number | null;
  /** The first open deadline within the person's grants. */
  nextDeadline: { title: string; dueDate: string; daysLeft: number } | null;
  /** Masked codes, for who manages the organization only. */
  identifiers: { taxCode: string | null; vatNumber: string | null } | null;
};

/** Keeps the first 3 and the last 4 characters: enough to recognize the code, not to copy it. */
export function maskCode(code: string | null): string | null {
  if (!code) return null;
  if (code.length <= 7) return '•'.repeat(code.length);
  return `${code.slice(0, 3)}${'•'.repeat(code.length - 7)}${code.slice(-4)}`;
}

/** A permission the person may have, or not; a function turned off counts as not having it. */
function grantOf(principal: Principal, permission: Parameters<typeof authorize>[1]) {
  try {
    return authorize(principal, permission);
  } catch (err: unknown) {
    if (err instanceof FeatureDisabledError || err instanceof PermissionDeniedError) return null;
    throw err;
  }
}

export async function getCompanyCard(
  prisma: PrismaClient,
  compliance: Pick<ComplianceService, 'listDeadlines'> | undefined,
  principal: Principal,
): Promise<CompanyCard> {
  const org = await prisma.tenant.findUniqueOrThrow({
    where: { id: principal.tenantId },
    select: {
      name: true,
      type: true,
      municipality: true,
      sector: true,
      taxCode: true,
      vatNumber: true,
      parentRelations: {
        where: { status: 'ACTIVE', relationType: 'MEMBER_OF' },
        orderBy: { createdAt: 'asc' },
        select: { parent: { select: { name: true } } },
      },
    },
  });

  const practices = grantOf(principal, 'practice.read');
  const deadlines = compliance ? grantOf(principal, 'compliance.read') : null;

  const practiceWhere = (): Prisma.PracticeWhereInput => {
    const reach = practiceReach(practices!);
    return {
      tenantId: principal.tenantId,
      status: { notIn: CLOSED },
      ...(reach.userId ? personPracticesWhere(reach.userId) : {}),
      ...(reach.reachableBy
        ? {
            OR: [
              { userId: reach.reachableBy },
              { holderUserId: reach.reachableBy },
              { assignedTo: reach.reachableBy },
            ],
          }
        : {}),
    };
  };

  const [openPractices, upcoming] = await Promise.all([
    practices ? prisma.practice.count({ where: practiceWhere() }) : Promise.resolve(null),
    deadlines && compliance
      ? compliance.listDeadlines({
          tenantId: principal.tenantId,
          status: 'OPEN',
          userId: deadlines.scope === 'tenant' ? undefined : principal.userId,
          limit: 1,
        })
      : Promise.resolve([]),
  ]);

  const manages = permits(principal, 'organization.manage');
  const first = upcoming[0];
  return {
    name: org.name,
    type: org.type,
    municipality: org.municipality,
    sector: org.sector,
    networks: org.parentRelations.map((r) => r.parent.name),
    openPractices,
    nextDeadline: first
      ? { title: first.title, dueDate: first.dueDate, daysLeft: first.daysLeft }
      : null,
    identifiers: manages
      ? { taxCode: maskCode(org.taxCode), vatNumber: maskCode(org.vatNumber) }
      : null,
  };
}

/**
 * The full codes, for who manages the organization only (null for anyone else). Every request is
 * recorded, with the channel and never the values.
 */
export async function revealCompanyIdentifiers(
  prisma: PrismaClient,
  principal: Principal,
  channel: string,
): Promise<{ taxCode: string | null; vatNumber: string | null } | null> {
  if (!permits(principal, 'organization.manage')) return null;
  const org = await prisma.tenant.findUniqueOrThrow({
    where: { id: principal.tenantId },
    select: { taxCode: true, vatNumber: true },
  });
  await new AuditService(prisma).logEvent({
    tenantId: principal.tenantId,
    userId: principal.userId,
    eventType: 'COMPANY_IDENTIFIERS_VIEWED',
    payload: { channel },
  });
  return { taxCode: org.taxCode, vatNumber: org.vatNumber };
}
