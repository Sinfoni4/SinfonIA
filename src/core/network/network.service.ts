import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';

import type { PrismaTx } from '../../data/types/prisma.js';
import type { OrganizationType, PrismaClient, RelationStatus } from '@prisma/client';

/**
 * MF9 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §1.2): a network invites a company, an
 * administrator of the company confirms or refuses, either side can end it. A membership gives
 * the network the minimal profile of the company and its inclusion in aggregate statistics:
 * **never any permission on its data** (that needs a delegation, MF8).
 */

/** Types that can have member organizations (docs/PROGETTO_FRONTEND_V2.md §4.2, G5). */
export const NETWORK_TYPES: readonly OrganizationType[] = [
  'NETWORK',
  'CONSORTIUM',
  'TRADE_ASSOCIATION',
  'ASSOCIATION',
];

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 409 = 400,
    readonly code = 'NETWORK_INVALID',
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type MemberOrganization = {
  relationId: string;
  orgId: string;
  name: string;
  type: OrganizationType;
  municipality: string | null;
  sector: string | null;
  status: RelationStatus;
  invitedAt: Date;
  startedAt: Date | null;
};

export type MyNetwork = {
  relationId: string;
  networkId: string;
  name: string;
  type: OrganizationType;
  status: RelationStatus;
  invitedAt: Date;
  startedAt: Date | null;
};

async function requireNetwork(db: PrismaTx | PrismaClient, networkId: string) {
  const org = await db.tenant.findUnique({
    where: { id: networkId },
    select: { id: true, name: true, type: true },
  });
  if (!org) throw new NotFoundError('Organization not found');
  if (!NETWORK_TYPES.includes(org.type)) {
    throw new NetworkError(
      'Funzione disponibile solo per reti, consorzi e associazioni',
      403,
      'NOT_A_NETWORK',
    );
  }
  return org;
}

/** The member companies of a network (active and invited), with their minimal profile only. */
export async function listNetworkMembers(
  prisma: PrismaClient,
  networkId: string,
): Promise<MemberOrganization[]> {
  await requireNetwork(prisma, networkId);
  const rows = await prisma.organizationRelation.findMany({
    where: {
      parentOrgId: networkId,
      relationType: 'MEMBER_OF',
      status: { in: ['PENDING', 'ACTIVE'] },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      child: { select: { id: true, name: true, type: true, municipality: true, sector: true } },
    },
  });
  return rows.map((r) => ({
    relationId: r.id,
    orgId: r.child.id,
    name: r.child.name,
    type: r.child.type,
    municipality: r.child.municipality,
    sector: r.child.sector,
    status: r.status,
    invitedAt: r.createdAt,
    startedAt: r.startedAt,
  }));
}

/**
 * The network invites a company by its membership code (the id the company sees in «Adesioni»).
 * An ended or refused membership can be asked again.
 */
export async function inviteMember(
  prisma: PrismaClient,
  input: { networkId: string; childOrgId: string; actorUserId: string },
): Promise<{ relationId: string }> {
  const { relationId } = await withTransaction(prisma, (tx) => inviteMemberInTx(tx, input));
  return { relationId };
}

/**
 * The invitation inside a transaction of the caller. `byPlatform`: sent from the platform
 * console (Cantiere 1, voce 17): the network's log shows it as done by the platform, without the
 * name of the administrator; the company still has to confirm it.
 */
export async function inviteMemberInTx(
  tx: PrismaTx,
  input: { networkId: string; childOrgId: string; actorUserId: string; byPlatform?: boolean },
): Promise<{ relationId: string; network: string; organization: string }> {
  const network = await requireNetwork(tx, input.networkId);
  if (input.childOrgId === input.networkId) {
    throw new NetworkError("Un'organizzazione non può aderire a sé stessa");
  }
  const child = await tx.tenant.findUnique({
    where: { id: input.childOrgId },
    select: { id: true, name: true, status: true },
  });
  if (!child || child.status !== 'ACTIVE') {
    throw new NetworkError('Codice di adesione non valido', 400, 'UNKNOWN_ORGANIZATION');
  }
  const existing = await tx.organizationRelation.findUnique({
    where: {
      parentOrgId_childOrgId_relationType: {
        parentOrgId: input.networkId,
        childOrgId: input.childOrgId,
        relationType: 'MEMBER_OF',
      },
    },
    select: { id: true, status: true },
  });
  if (existing && existing.status !== 'ENDED') {
    throw new NetworkError(
      existing.status === 'ACTIVE'
        ? `${child.name} aderisce già alla rete`
        : `L'invito a ${child.name} è già in attesa`,
      409,
      'ALREADY_MEMBER',
    );
  }
  const data = {
    status: 'PENDING' as const,
    requestedBy: input.actorUserId,
    confirmedBy: null,
    startedAt: null,
    endedAt: null,
    endedBy: null,
    refused: false,
  };
  const relation = existing
    ? await tx.organizationRelation.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      })
    : await tx.organizationRelation.create({
        data: { parentOrgId: input.networkId, childOrgId: input.childOrgId, ...data },
        select: { id: true },
      });
  const audit = new AuditService(tx);
  await audit.logEvent({
    tenantId: input.networkId,
    userId: input.byPlatform ? null : input.actorUserId,
    eventType: 'NETWORK_INVITATION_SENT',
    payload: {
      relationId: relation.id,
      organization: child.name,
      ...(input.byPlatform ? { byPlatform: true } : {}),
    },
  });
  // The company sees the request in its own log too.
  await audit.logEvent({
    tenantId: input.childOrgId,
    userId: null,
    eventType: 'NETWORK_INVITATION_RECEIVED',
    payload: { relationId: relation.id, organization: network.name },
  });
  return { relationId: relation.id, network: network.name, organization: child.name };
}

/** The networks of a company: invitations to answer and memberships in force. */
export async function listMyNetworks(prisma: PrismaClient, orgId: string): Promise<MyNetwork[]> {
  const rows = await prisma.organizationRelation.findMany({
    where: { childOrgId: orgId, relationType: 'MEMBER_OF', status: { in: ['PENDING', 'ACTIVE'] } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      parent: { select: { id: true, name: true, type: true } },
    },
  });
  return rows.map((r) => ({
    relationId: r.id,
    networkId: r.parent.id,
    name: r.parent.name,
    type: r.parent.type,
    status: r.status,
    invitedAt: r.createdAt,
    startedAt: r.startedAt,
  }));
}

export type MembershipAction = 'confirm' | 'refuse' | 'leave';

/**
 * A change of a membership. `side` says who acts: the company (confirm, refuse, leave) or the
 * network (end). Every change is recorded in the log of both organizations.
 */
export async function changeMembership(
  prisma: PrismaClient,
  input: {
    relationId: string;
    actorOrgId: string;
    actorUserId: string;
    action: MembershipAction | 'end';
  },
): Promise<{ status: RelationStatus }> {
  return withTransaction(prisma, async (tx) => {
    const byNetwork = input.action === 'end';
    const relation = await tx.organizationRelation.findFirst({
      where: {
        id: input.relationId,
        relationType: 'MEMBER_OF',
        ...(byNetwork ? { parentOrgId: input.actorOrgId } : { childOrgId: input.actorOrgId }),
      },
      select: {
        status: true,
        parentOrgId: true,
        childOrgId: true,
        parent: { select: { name: true } },
        child: { select: { name: true } },
      },
    });
    if (!relation) throw new NotFoundError('Membership not found');
    if (byNetwork) await requireNetwork(tx, input.actorOrgId);
    const now = new Date();
    let data: Parameters<typeof tx.organizationRelation.updateMany>[0]['data'];
    let allowed: RelationStatus[];
    let eventType: string;
    switch (input.action) {
      case 'confirm':
        allowed = ['PENDING'];
        data = { status: 'ACTIVE', confirmedBy: input.actorUserId, startedAt: now };
        eventType = 'NETWORK_MEMBERSHIP_CONFIRMED';
        break;
      case 'refuse':
        allowed = ['PENDING'];
        data = { status: 'ENDED', refused: true, endedAt: now, endedBy: input.actorUserId };
        eventType = 'NETWORK_MEMBERSHIP_REFUSED';
        break;
      default:
        allowed = byNetwork ? ['PENDING', 'ACTIVE'] : ['ACTIVE'];
        data = { status: 'ENDED', endedAt: now, endedBy: input.actorUserId };
        eventType = 'NETWORK_MEMBERSHIP_ENDED';
    }
    const updated = await tx.organizationRelation.updateMany({
      where: { id: input.relationId, status: { in: allowed } },
      data,
    });
    if (updated.count === 0) {
      throw new NetworkError(
        "L'adesione è già cambiata: ricarica la pagina",
        409,
        'MEMBERSHIP_CHANGED',
      );
    }
    const audit = new AuditService(tx);
    for (const [orgId, other, userId] of [
      [relation.parentOrgId, relation.child.name, byNetwork ? input.actorUserId : null],
      [relation.childOrgId, relation.parent.name, byNetwork ? null : input.actorUserId],
    ] as const) {
      await audit.logEvent({
        tenantId: orgId,
        userId,
        eventType,
        payload: {
          relationId: input.relationId,
          organization: other,
          by: byNetwork ? 'network' : 'company',
        },
      });
    }
    return { status: input.action === 'confirm' ? 'ACTIVE' : 'ENDED' };
  });
}
