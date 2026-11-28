import { Prisma } from '@prisma/client';

import { NotFoundError } from '../../data/errors/errors.js';
import { AuditService } from '../../data/services/audit.service.js';
import { withTransaction } from '../../data/transactions/transaction.js';
import {
  isSectorFeature,
  sectorFeature,
  sectorFeatureApplies,
  sectorFeaturesOf,
  type SectorChannel,
} from '../../modules/registry.js';
import { FEATURE_LABELS, FEATURES, isFeature, type Feature } from '../features/features.js';
import { inviteMemberInTx, NETWORK_TYPES } from '../network/network.service.js';
import {
  changeMark,
  normalizeExternalRefs,
  normalizeTaxCode,
  normalizeVatNumber,
  readExternalRefs,
  sameRefs,
  type ExternalRefs,
} from '../organization/company-identifiers.js';
import { profileActivitiesOf } from '../organization/company-profile.service.js';
import { replaceOrganizationLogo } from '../organization/organization-logo.js';

import type { StorageService } from '../../data/storage/storage.service.js';
import type { LoginService } from '../identity/login.service.js';
import type { ModuleId } from '../modules/module.contract.js';
import type { OrganizationStatus, OrganizationType, PrismaClient } from '@prisma/client';

/**
 * The platform console (docs/PROGETTO_FRONTEND_V2.md §5, A1-A3 and A6; G3, G9): organizations
 * with counts, dates and administrator contacts only. This is the only module that reads across
 * organizations, and it never reads practices, attachments, deadlines or other people's data
 * (tests/fe7.platform-console.test.ts checks it). Every action goes to the platform audit log and,
 * when it concerns an organization, to that organization's activity log too.
 */

const PLACEHOLDER_EMAIL = /@local\.invalid$/i;

export class PlatformActionError extends Error {
  readonly statusCode = 409;
  readonly code = 'PLATFORM_ACTION_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'PlatformActionError';
  }
}

export type PlatformActor = { userId: string };

type Tx = Prisma.TransactionClient;

async function logPlatform(
  tx: Tx,
  entry: { actor: PlatformActor; action: string; orgId?: string; payload?: Prisma.InputJsonValue },
): Promise<void> {
  await tx.platformAuditLog.create({
    data: {
      actorUserId: entry.actor.userId,
      action: entry.action,
      orgId: entry.orgId ?? null,
      payload: entry.payload ?? {},
    },
  });
}

/** The organization sees what the platform did to it, without the name of the administrator. */
async function logInOrganization(tx: Tx, orgId: string, eventType: string): Promise<void> {
  await new AuditService(tx).logEvent({
    tenantId: orgId,
    userId: null,
    eventType,
    payload: { byPlatform: true },
  });
}

// --- A1: list -----------------------------------------------------------------------------------

export type OrganizationRow = {
  id: string;
  name: string;
  type: OrganizationType;
  status: OrganizationStatus;
  /** A02: the sector module (one of MODULE_IDS). */
  module: string;
  /** A03: common functions turned off. */
  disabledFeatures: string[];
  /** Functions of the sector on in the dashboard (only those of `module` count). */
  enabledFeatures: string[];
  /** Functions of the sector on in the Telegram Mini App. */
  miniAppFeatures: string[];
  createdAt: Date;
  members: number;
  practices: number;
  lastActivityAt: Date | null;
};

export async function listOrganizations(
  prisma: PrismaClient,
  input: {
    page: number;
    limit: number;
    search?: string;
    type?: OrganizationType;
    status?: OrganizationStatus;
    module?: ModuleId;
  },
): Promise<{ items: OrganizationRow[]; total: number; page: number; totalPages: number }> {
  const where: Prisma.TenantWhereInput = {
    ...(input.search ? { name: { contains: input.search, mode: 'insensitive' } } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.module ? { module: input.module } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        module: true,
        disabledFeatures: true,
        enabledFeatures: true,
        miniAppFeatures: true,
        createdAt: true,
      },
    }),
  ]);
  const ids = rows.map((r) => r.id);
  const [members, practices, activity] = ids.length
    ? await Promise.all([
        prisma.membership.groupBy({
          by: ['orgId'],
          where: { orgId: { in: ids }, status: 'ACTIVE' },
          _count: { _all: true },
        }),
        prisma.practice.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids } },
          _count: { _all: true },
        }),
        prisma.auditLog.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids } },
          _max: { createdAt: true },
        }),
      ])
    : [[], [], []];
  const memberCount = new Map(members.map((m) => [m.orgId, m._count._all]));
  const practiceCount = new Map(practices.map((p) => [p.tenantId, p._count._all]));
  const lastActivity = new Map(activity.map((a) => [a.tenantId, a._max.createdAt]));
  return {
    items: rows.map((r) => ({
      ...r,
      members: memberCount.get(r.id) ?? 0,
      practices: practiceCount.get(r.id) ?? 0,
      lastActivityAt: lastActivity.get(r.id) ?? null,
    })),
    total,
    page: input.page,
    totalPages: Math.ceil(total / input.limit),
  };
}

// --- A3: detail ---------------------------------------------------------------------------------

export type OrganizationDetail = OrganizationRow & {
  scheduledExport: boolean;
  webhook: boolean;
  deactivatedAt: Date | null;
  /** G3: the contact of the active administrators, never other members. */
  administrators: Array<{ email: string | null; since: Date }>;
  pendingInvitations: number;
  /** AGX-02: codice fiscale / CUAA, partita IVA and codes in other systems. */
  identifiers: CompanyIdentifiers;
  /** When the logo shown in the Mini App last changed; null without a logo. */
  logoUpdatedAt: Date | null;
  /**
   * Fase 1C: the activities the company declared in its profile, by label, never the details;
   * null when the organization has no company profile.
   */
  profileActivities: Array<{ id: string; label: string }> | null;
};

export type CompanyIdentifiers = {
  taxCode: string | null;
  vatNumber: string | null;
  externalRefs: ExternalRefs;
};

export async function getOrganization(
  prisma: PrismaClient,
  orgId: string,
  now = new Date(),
): Promise<OrganizationDetail> {
  const org = await prisma.tenant.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      createdAt: true,
      module: true,
      disabledFeatures: true,
      enabledFeatures: true,
      miniAppFeatures: true,
      schedulerEnabled: true,
      integrationType: true,
      deactivatedAt: true,
      taxCode: true,
      vatNumber: true,
      externalRefs: true,
      logoPath: true,
      logoUpdatedAt: true,
    },
  });
  if (!org) throw new NotFoundError('Organization not found');
  const [members, practices, last, admins, pendingInvitations] = await Promise.all([
    prisma.membership.count({ where: { orgId, status: 'ACTIVE' } }),
    prisma.practice.count({ where: { tenantId: orgId } }),
    prisma.auditLog.aggregate({ where: { tenantId: orgId }, _max: { createdAt: true } }),
    prisma.membership.findMany({
      where: { orgId, status: 'ACTIVE', role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, user: { select: { email: true } } },
    }),
    prisma.invitation.count({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    }),
  ]);
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    status: org.status,
    createdAt: org.createdAt,
    members,
    practices,
    lastActivityAt: last._max.createdAt,
    module: org.module,
    disabledFeatures: org.disabledFeatures,
    enabledFeatures: org.enabledFeatures,
    miniAppFeatures: org.miniAppFeatures,
    scheduledExport: org.schedulerEnabled,
    webhook: org.integrationType === 'external',
    deactivatedAt: org.deactivatedAt,
    administrators: admins.map((a) => ({
      email: PLACEHOLDER_EMAIL.test(a.user.email) ? null : a.user.email,
      since: a.createdAt,
    })),
    pendingInvitations,
    identifiers: {
      taxCode: org.taxCode,
      vatNumber: org.vatNumber,
      externalRefs: readExternalRefs(org.externalRefs),
    },
    logoUpdatedAt: org.logoPath ? org.logoUpdatedAt : null,
    profileActivities: await profileActivitiesOf(prisma, org),
  };
}

// --- The logo shown in the Telegram Mini App ---------------------------------------------------

/** Sets (or, with null, removes) the logo of an organization, from the platform console. */
export function setOrganizationLogo(
  prisma: PrismaClient,
  storage: StorageService,
  orgId: string,
  logo: { contentType: string; data: Buffer } | null,
  actor: PlatformActor,
): Promise<{ logoUpdatedAt: Date | null }> {
  return replaceOrganizationLogo(prisma, storage, orgId, logo, async (tx, action, saved) => {
    await logPlatform(tx, {
      actor,
      action,
      orgId,
      payload: saved ? { type: saved.type, bytes: saved.size } : {},
    });
    await logInOrganization(tx, orgId, action);
  });
}

/**
 * AGX-02: the console sets the identifiers of a company, the codes in other systems included.
 * Both audit logs record which ones changed, never their values.
 */
export async function setOrganizationIdentifiers(
  prisma: PrismaClient,
  orgId: string,
  input: {
    taxCode?: string | null;
    vatNumber?: string | null;
    externalRefs?: Record<string, string> | null;
  },
  actor: PlatformActor,
): Promise<CompanyIdentifiers> {
  const taxCode = normalizeTaxCode(input.taxCode);
  const vatNumber = normalizeVatNumber(input.vatNumber);
  const externalRefs = normalizeExternalRefs(input.externalRefs);
  return withTransaction(prisma, async (tx) => {
    const org = await tx.tenant.findUnique({
      where: { id: orgId },
      select: { taxCode: true, vatNumber: true, externalRefs: true },
    });
    if (!org) throw new NotFoundError('Organization not found');
    const data: Prisma.TenantUpdateInput = {};
    const changed: Record<string, string | string[]> = {};
    if (taxCode !== undefined && taxCode !== org.taxCode) {
      data.taxCode = taxCode;
      changed.taxCode = changeMark(taxCode);
    }
    if (vatNumber !== undefined && vatNumber !== org.vatNumber) {
      data.vatNumber = vatNumber;
      changed.vatNumber = changeMark(vatNumber);
    }
    if (externalRefs !== undefined && !sameRefs(org.externalRefs, externalRefs)) {
      data.externalRefs = externalRefs ?? Prisma.DbNull;
      changed.externalRefs = Object.keys(externalRefs ?? {});
    }
    const result = {
      taxCode: taxCode === undefined ? org.taxCode : taxCode,
      vatNumber: vatNumber === undefined ? org.vatNumber : vatNumber,
      externalRefs:
        externalRefs === undefined ? readExternalRefs(org.externalRefs) : (externalRefs ?? {}),
    };
    if (Object.keys(changed).length === 0) return result;
    await tx.tenant.update({ where: { id: orgId }, data });
    await logPlatform(tx, {
      actor,
      action: 'ORGANIZATION_IDENTIFIERS_CHANGED',
      orgId,
      payload: changed,
    });
    await logInOrganization(tx, orgId, 'ORGANIZATION_IDENTIFIERS_CHANGED');
    return result;
  });
}

// --- A2: new organization -----------------------------------------------------------------------

export async function createOrganization(
  prisma: PrismaClient,
  login: Pick<LoginService, 'createInvitation'>,
  input: { name: string; type: OrganizationType; firstAdminEmail: string; module?: ModuleId },
  actor: PlatformActor,
): Promise<{ orgId: string; invitationId: string; devToken?: string }> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new PlatformActionError('Il nome deve avere da 2 a 120 caratteri');
  }
  const exists = await prisma.tenant.count({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (exists > 0) throw new PlatformActionError('Esiste già un’organizzazione con questo nome');
  const org = await withTransaction(prisma, async (tx) => {
    const created = await tx.tenant.create({
      data: { name, type: input.type, ...(input.module ? { module: input.module } : {}) },
      select: { id: true, module: true },
    });
    await logPlatform(tx, {
      actor,
      action: 'ORGANIZATION_CREATED',
      orgId: created.id,
      payload: { name, type: input.type, module: created.module },
    });
    await logInOrganization(tx, created.id, 'ORGANIZATION_CREATED');
    return created;
  });
  // The first administrator gets a normal invitation: the platform never creates accounts.
  const invitation = await login.createInvitation(org.id, input.firstAdminEmail, 'ADMIN', {
    userId: actor.userId,
    platform: true,
  });
  await prisma.platformAuditLog.create({
    data: {
      actorUserId: actor.userId,
      action: 'FIRST_ADMIN_INVITED',
      orgId: org.id,
      payload: { invitationId: invitation.invitationId },
    },
  });
  return { orgId: org.id, ...invitation };
}

// --- A3: suspension (G9) ------------------------------------------------------------------------

/**
 * Suspends or reactivates an organization. Suspension blocks its members at once on dashboard,
 * API and chat (the authorization checks the organization status at every request) and stops
 * its scheduled tasks; no data is touched.
 */
export async function setOrganizationSuspended(
  prisma: PrismaClient,
  orgId: string,
  suspended: boolean,
  actor: PlatformActor,
  reason?: string,
): Promise<{ status: OrganizationStatus }> {
  const from: OrganizationStatus = suspended ? 'ACTIVE' : 'SUSPENDED';
  const to: OrganizationStatus = suspended ? 'SUSPENDED' : 'ACTIVE';
  await withTransaction(prisma, async (tx) => {
    const org = await tx.tenant.findUnique({ where: { id: orgId }, select: { status: true } });
    if (!org) throw new NotFoundError('Organization not found');
    const changed = await tx.tenant.updateMany({
      where: { id: orgId, status: from },
      data: { status: to },
    });
    if (changed.count !== 1) {
      throw new PlatformActionError(
        suspended
          ? 'Si sospende solo un’organizzazione attiva'
          : 'Si riattiva solo un’organizzazione sospesa',
      );
    }
    const action = suspended ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_REACTIVATED';
    await logPlatform(tx, {
      actor,
      action,
      orgId,
      payload: reason ? { reason } : {},
    });
    await logInOrganization(tx, orgId, action);
  });
  return { status: to };
}

// --- A03: module and functions of an organization -------------------------------------------

/** The functions of each kind of an organization, as the console sets and reads them. */
export type OrganizationFeatures = {
  disabledFeatures: string[];
  /** Functions of the sector on in the dashboard. */
  enabledFeatures: string[];
  /** Functions of the sector on in the Telegram Mini App. */
  miniAppFeatures: string[];
};

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((f) => b.includes(f));

/**
 * Sets the module of an organization and the functions turned off for it. Takes effect at the
 * next request of its members (the authorization reads them every time); no data is touched:
 * deadlines or documents of a function turned off stay, unreachable, until it is turned on again.
 */
export async function setOrganizationModules(
  prisma: PrismaClient,
  orgId: string,
  input: {
    module: ModuleId;
    disabledFeatures: Feature[];
    enabledFeatures?: string[];
    miniAppFeatures?: string[];
  },
  actor: PlatformActor,
): Promise<OrganizationFeatures & { module: ModuleId }> {
  const disabledFeatures = FEATURES.filter((f) => input.disabledFeatures.includes(f));
  return withTransaction(prisma, async (tx) => {
    const org = await tx.tenant.findUnique({
      where: { id: orgId },
      select: {
        module: true,
        disabledFeatures: true,
        enabledFeatures: true,
        miniAppFeatures: true,
      },
    });
    if (!org) throw new NotFoundError('Organization not found');
    // Functions of a sector: only those of the new module are kept, given or not.
    const ofModule = (list: readonly string[]) =>
      sectorFeaturesOf(input.module)
        .map((f) => f.id)
        .filter((id) => list.includes(id));
    const enabledFeatures = ofModule(input.enabledFeatures ?? org.enabledFeatures);
    const miniAppFeatures = ofModule(input.miniAppFeatures ?? org.miniAppFeatures);
    const same =
      org.module === input.module &&
      sameList(org.disabledFeatures, disabledFeatures) &&
      sameList(org.enabledFeatures, enabledFeatures) &&
      sameList(org.miniAppFeatures, miniAppFeatures);
    if (!same) {
      await tx.tenant.update({
        where: { id: orgId },
        data: { module: input.module, disabledFeatures, enabledFeatures, miniAppFeatures },
      });
      await logPlatform(tx, {
        actor,
        action: 'ORGANIZATION_MODULES_CHANGED',
        orgId,
        payload: { module: input.module, disabledFeatures, enabledFeatures, miniAppFeatures },
      });
      await logInOrganization(tx, orgId, 'ORGANIZATION_MODULES_CHANGED');
    }
    return { module: input.module, disabledFeatures, enabledFeatures, miniAppFeatures };
  });
}

function labelOf(feature: string): string {
  return isFeature(feature) ? FEATURE_LABELS[feature] : (sectorFeature(feature)?.label ?? feature);
}

/**
 * The console's table of functions: turns one function on or off for an organization. A common
 * function (features.ts) is on unless turned off, everywhere; a function of a sector
 * (sector-features.ts) is off unless turned on, only for an organization of that sector, and in
 * the dashboard and in the Mini App apart (`channel`). Recorded like the module.
 */
export async function setOrganizationFeature(
  prisma: PrismaClient,
  orgId: string,
  input: { feature: string; enabled: boolean; channel?: SectorChannel },
  actor: PlatformActor,
): Promise<OrganizationFeatures> {
  const { feature, enabled } = input;
  if (!isFeature(feature) && !isSectorFeature(feature)) {
    throw new NotFoundError('Feature not found');
  }
  if (isFeature(feature) && input.channel) {
    throw new PlatformActionError(
      'Le funzioni comuni valgono ovunque: il canale si sceglie solo per quelle di settore',
    );
  }
  const channel = input.channel ?? 'dashboard';
  return withTransaction(prisma, async (tx) => {
    const org = await tx.tenant.findUnique({
      where: { id: orgId },
      select: {
        module: true,
        disabledFeatures: true,
        enabledFeatures: true,
        miniAppFeatures: true,
      },
    });
    if (!org) throw new NotFoundError('Organization not found');
    let { disabledFeatures, enabledFeatures, miniAppFeatures } = org;
    const toggle = (list: string[]) => {
      const rest = list.filter((f) => f !== feature);
      return enabled ? [...rest, feature] : rest;
    };
    if (isFeature(feature)) {
      // Stored the other way round: the list of those turned off.
      const rest = disabledFeatures.filter((f) => f !== feature);
      disabledFeatures = enabled ? rest : [...rest, feature];
    } else {
      if (enabled && !sectorFeatureApplies(feature, org.module)) {
        throw new PlatformActionError(
          "Questa funzione non è del settore dell'organizzazione: cambia prima il settore",
        );
      }
      if (channel === 'miniapp') miniAppFeatures = toggle(miniAppFeatures);
      else enabledFeatures = toggle(enabledFeatures);
    }
    const same =
      sameList(org.disabledFeatures, disabledFeatures) &&
      sameList(org.enabledFeatures, enabledFeatures) &&
      sameList(org.miniAppFeatures, miniAppFeatures);
    if (!same) {
      await tx.tenant.update({
        where: { id: orgId },
        data: { disabledFeatures, enabledFeatures, miniAppFeatures },
      });
      await logPlatform(tx, {
        actor,
        action: 'ORGANIZATION_FEATURE_CHANGED',
        orgId,
        payload: {
          feature,
          featureLabel: labelOf(feature),
          enabled,
          ...(isFeature(feature) ? {} : { channel }),
        },
      });
      await logInOrganization(tx, orgId, 'ORGANIZATION_FEATURE_CHANGED');
    }
    return { disabledFeatures, enabledFeatures, miniAppFeatures };
  });
}

// --- Cantiere 1, voce 17: network and companies from the console -----------------------------

export type OrganizationLink = {
  relationId: string;
  orgId: string;
  name: string;
  status: 'PENDING' | 'ACTIVE';
  since: Date;
};

/**
 * The memberships of an organization, as the console shows them: its member companies when it
 * is a network, the networks it belongs to otherwise. Names and states only, never their data.
 */
export async function listOrganizationLinks(
  prisma: PrismaClient,
  orgId: string,
): Promise<{ isNetwork: boolean; members: OrganizationLink[]; networks: OrganizationLink[] }> {
  const org = await prisma.tenant.findUnique({ where: { id: orgId }, select: { type: true } });
  if (!org) throw new NotFoundError('Organization not found');
  const select = {
    id: true,
    status: true,
    createdAt: true,
    startedAt: true,
    parent: { select: { id: true, name: true } },
    child: { select: { id: true, name: true } },
  } as const;
  const where = {
    relationType: 'MEMBER_OF' as const,
    status: { in: ['PENDING' as const, 'ACTIVE' as const] },
  };
  const [asNetwork, asMember] = await Promise.all([
    prisma.organizationRelation.findMany({
      where: { ...where, parentOrgId: orgId },
      orderBy: { createdAt: 'asc' },
      select,
    }),
    prisma.organizationRelation.findMany({
      where: { ...where, childOrgId: orgId },
      orderBy: { createdAt: 'asc' },
      select,
    }),
  ]);
  const link = (r: (typeof asNetwork)[number], other: { id: string; name: string }) => ({
    relationId: r.id,
    orgId: other.id,
    name: other.name,
    status: r.status as 'PENDING' | 'ACTIVE',
    since: r.startedAt ?? r.createdAt,
  });
  return {
    isNetwork: NETWORK_TYPES.includes(org.type),
    members: asNetwork.map((r) => link(r, r.child)),
    networks: asMember.map((r) => link(r, r.parent)),
  };
}

/**
 * The platform invites a company into a network, as the network itself could: the membership
 * starts only when an administrator of the company confirms it, and gives the network no access
 * to the company's data. Recorded in the platform log and in the logs of both organizations.
 */
export async function inviteToNetwork(
  prisma: PrismaClient,
  networkId: string,
  childOrgId: string,
  actor: PlatformActor,
): Promise<{ relationId: string }> {
  return withTransaction(prisma, async (tx) => {
    const sent = await inviteMemberInTx(tx, {
      networkId,
      childOrgId,
      actorUserId: actor.userId,
      byPlatform: true,
    });
    await logPlatform(tx, {
      actor,
      action: 'NETWORK_INVITATION_SENT',
      orgId: networkId,
      payload: { organization: sent.organization, childOrgId },
    });
    return { relationId: sent.relationId };
  });
}

// --- A6: platform audit log ---------------------------------------------------------------------

export type PlatformAuditRow = {
  id: string;
  at: Date;
  action: string;
  actorEmail: string | null;
  organization: { id: string; name: string | null } | null;
  /** The person a role change is about (another platform administrator). */
  targetEmail: string | null;
  details: Partial<
    Record<
      | 'name'
      | 'type'
      | 'reason'
      | 'via'
      | 'module'
      | 'organization'
      | 'feature'
      | 'featureLabel'
      | 'channel',
      string
    >
  > & {
    disabledFeatures?: string[];
    enabledFeatures?: string[];
    miniAppFeatures?: string[];
    /** ORGANIZATION_FEATURE_CHANGED: whether `feature` was turned on. */
    enabled?: boolean;
  };
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listPlatformAudit(
  prisma: PrismaClient,
  input: { page: number; limit: number; orgId?: string },
): Promise<{ items: PlatformAuditRow[]; total: number; page: number; totalPages: number }> {
  const where: Prisma.PlatformAuditLogWhereInput = input.orgId ? { orgId: input.orgId } : {};
  const [total, rows] = await Promise.all([
    prisma.platformAuditLog.count({ where }),
    prisma.platformAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    }),
  ]);
  const targetOf = (payload: unknown) => {
    const target = recordOf(payload).targetUserId;
    return typeof target === 'string' ? target : null;
  };
  const actorIds = [
    ...new Set(
      rows.flatMap((r) => [r.actorUserId, targetOf(r.payload)]).filter((id): id is string => !!id),
    ),
  ];
  const orgIds = [...new Set(rows.map((r) => r.orgId).filter((id): id is string => !!id))];
  const [actors, orgs] = await Promise.all([
    actorIds.length
      ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
      : Promise.resolve([]),
    orgIds.length
      ? prisma.tenant.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const emails = new Map(actors.map((a) => [a.id, a.email]));
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  return {
    items: rows.map((r) => {
      const payload = recordOf(r.payload);
      const target = targetOf(r.payload);
      const details: PlatformAuditRow['details'] = {};
      const keys = [
        'name',
        'type',
        'reason',
        'via',
        'module',
        'organization',
        'feature',
        'featureLabel',
        'channel',
      ] as const;
      for (const key of keys) {
        if (typeof payload[key] === 'string') details[key] = payload[key];
      }
      if (typeof payload.enabled === 'boolean') details.enabled = payload.enabled;
      if (Array.isArray(payload.disabledFeatures)) {
        details.disabledFeatures = payload.disabledFeatures.filter((f) => typeof f === 'string');
      }
      if (Array.isArray(payload.enabledFeatures)) {
        details.enabledFeatures = payload.enabledFeatures.filter((f) => typeof f === 'string');
      }
      if (Array.isArray(payload.miniAppFeatures)) {
        details.miniAppFeatures = payload.miniAppFeatures.filter((f) => typeof f === 'string');
      }
      return {
        id: r.id,
        at: r.createdAt,
        action: r.action,
        actorEmail: r.actorUserId ? (emails.get(r.actorUserId) ?? null) : null,
        organization: r.orgId ? { id: r.orgId, name: names.get(r.orgId) ?? null } : null,
        targetEmail: target ? (emails.get(target) ?? null) : null,
        details,
      };
    }),
    total,
    page: input.page,
    totalPages: Math.ceil(total / input.limit),
  };
}
