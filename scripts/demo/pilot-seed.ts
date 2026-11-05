/**
 * Demo data of the pilot scenario (docs/FASE1_CORE_E_MODULI.md §6), for `npm run web:demo`:
 * an agricultural network with its companies, agricultural practices at different steps,
 * deadlines, and an external consultant who works for one company through a delegation.
 *
 * Every name, address and document is invented. It goes through the application's own services
 * (modules, fields, sub-states, memberships, delegations, audit), so the demo shows exactly what
 * the product does. Created once: a second run finds the network account and does nothing.
 */
import { ComplianceService } from '../../src/core/compliance/compliance.service.js';
import { issueGrant } from '../../src/core/delegation/delegation.service.js';
import { changeMembership, inviteMember } from '../../src/core/network/network.service.js';
import { setPracticeSubState } from '../../src/core/practice/practice-module.js';
import { TenantRepository } from '../../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../../src/data/repositories/user.repository.js';

import type { PracticeApplicationService } from '../../src/core/practice/practice.application.service.js';
import type { PracticeState } from '../../src/core/types/workflow.types.js';
import type { PrismaClient } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The accounts to sign in with; the 6-digit code is shown on the demo screen. */
export const PILOT_ACCOUNTS = {
  network: 'rete.demo@sinfonia.test',
  company: 'colleverde.demo@sinfonia.test',
  consultant: 'consulente.demo@sinfonia.test',
} as const;

type Step = { state?: PracticeState; subState?: string };
type DemoPractice = { name: string; fields: Record<string, unknown> } & Step;

const PATH: Record<PracticeState, PracticeState[]> = {
  CREATED: [],
  VALIDATED: ['VALIDATED'],
  SUBMITTED: ['VALIDATED', 'SUBMITTED'],
  COMPLETED: ['VALIDATED', 'SUBMITTED', 'COMPLETED'],
  FAILED: ['VALIDATED', 'SUBMITTED', 'FAILED'],
};

const COMPANIES: Array<{ name: string; practices: DemoPractice[] }> = [
  {
    name: 'Cantina Prato Alto',
    practices: [
      { name: 'Domanda PAC 2027', fields: { procedure: 'pac', campaignYear: 2027 } },
      {
        name: 'Domanda PAC 2026',
        fields: { procedure: 'pac', campaignYear: 2026 },
        state: 'COMPLETED',
      },
    ],
  },
  {
    name: 'Orti del Borgo',
    practices: [
      {
        name: 'Certificazione bio 2027',
        fields: { procedure: 'organic', campaignYear: 2027 },
        subState: 'collecting_documents',
      },
    ],
  },
  {
    name: 'Frutteti Val Chiara',
    practices: [
      {
        name: 'Bando sviluppo rurale: impianto antigrandine',
        fields: { procedure: 'csr', dueDate: '2027-02-28' },
        state: 'SUBMITTED',
        subState: 'under_review',
      },
    ],
  },
];

/** Practices of the company the consultant follows, one for each step of the agricultural module. */
const MAIN_COMPANY_PRACTICES: DemoPractice[] = [
  {
    name: 'Domanda PAC 2027',
    fields: { procedure: 'pac', campaignYear: 2027, dueDate: '2027-05-15' },
    subState: 'collecting_documents',
  },
  {
    name: 'Rinnovo certificazione biologica',
    fields: { procedure: 'organic', campaignYear: 2027 },
    state: 'SUBMITTED',
    subState: 'under_review',
  },
  {
    name: 'Bando sviluppo rurale: serra fotovoltaica',
    fields: { procedure: 'csr', dueDate: '2027-01-31' },
    state: 'SUBMITTED',
    subState: 'integration_requested',
  },
  {
    name: 'Domanda PAC 2026',
    fields: { procedure: 'pac', campaignYear: 2026 },
    state: 'COMPLETED',
  },
];

const FARM_FILE = [
  'FASCICOLO AZIENDALE (documento dimostrativo, dati inventati)',
  'Azienda Agricola Colle Verde',
  'CUAA 00000000000',
  'Superficie agricola utilizzata: 18,40 ha',
  'Colture: vite 6,20 ha; seminativi 9,80 ha; orticole 2,40 ha',
  'Aggiornato al 30/09/2026',
  '',
].join('\n');

/**
 * Creates the pilot scenario once. `tag` is added to names and emails, so a test can create its
 * own copy next to the demo one; the demo uses no tag.
 */
export async function seedPilotScenario(
  prisma: PrismaClient,
  practices: PracticeApplicationService,
  options: { tag?: string; now?: Date } = {},
): Promise<{ created: boolean; networkId: string; companyId: string; consultantOrgId: string }> {
  const tag = options.tag ? ` ${options.tag}` : '';
  const email = (address: string) =>
    options.tag ? address.replace('@', `.${options.tag}@`) : address;
  const now = options.now ?? new Date();
  const isoDay = (offset: number) =>
    new Date(now.getTime() + offset * DAY_MS).toISOString().slice(0, 10);

  const existing = await prisma.membership.findFirst({
    where: { user: { email: email(PILOT_ACCOUNTS.network) } },
    select: { orgId: true },
  });
  if (existing) {
    return { created: false, networkId: existing.orgId, companyId: '', consultantOrgId: '' };
  }

  const tenants = new TenantRepository(prisma);
  const users = new UserRepository(prisma);
  const org = async (name: string, module: string, adminEmail: string) => {
    const id = (await tenants.createTenant({ name: `${name}${tag}`, module })).id;
    const admin = (await users.createUser(id, { email: email(adminEmail), role: 'ADMIN' })).id;
    return { id, admin };
  };
  const addPractices = async (orgId: string, userId: string, list: DemoPractice[]) => {
    const ids: string[] = [];
    for (const p of list) {
      const { id } = await practices.createPractice({
        tenantId: orgId,
        userId,
        name: p.name,
        kind: 'agri',
        fields: p.fields,
      });
      for (const nextState of PATH[p.state ?? 'CREATED']) {
        await practices.transitionPractice({ tenantId: orgId, userId, practiceId: id, nextState });
      }
      if (p.subState) {
        await setPracticeSubState(prisma, {
          tenantId: orgId,
          practiceId: id,
          subState: p.subState,
          actorUserId: userId,
        });
      }
      ids.push(id);
    }
    return ids;
  };

  // The network.
  const network = await org('Rete Agricola Demo', 'agri', PILOT_ACCOUNTS.network);
  await prisma.tenant.update({ where: { id: network.id }, data: { type: 'NETWORK' } });
  const join = async (childOrgId: string, childAdmin: string, confirm: boolean) => {
    const { relationId } = await inviteMember(prisma, {
      networkId: network.id,
      childOrgId,
      actorUserId: network.admin,
    });
    if (confirm) {
      await changeMembership(prisma, {
        relationId,
        actorOrgId: childOrgId,
        actorUserId: childAdmin,
        action: 'confirm',
      });
    }
  };

  // The company followed by the consultant, with documents and deadlines.
  const company = await org('Azienda Agricola Colle Verde', 'agri', PILOT_ACCOUNTS.company);
  await join(company.id, company.admin, true);
  const [pacId] = await addPractices(company.id, company.admin, MAIN_COMPANY_PRACTICES);
  await practices.addAttachment({
    tenantId: company.id,
    userId: company.admin,
    practiceId: pacId!,
    fileName: 'fascicolo-aziendale-demo.txt',
    mimeType: 'text/plain',
    content: Buffer.from(FARM_FILE),
  });
  const compliance = new ComplianceService(prisma, () => now);
  for (const [category, title, offset] of [
    ['DURC', 'DURC aziendale', 5],
    ['CERTIFICAZIONE_BIO', 'Rinnovo certificato biologico', 20],
    ['PATENTINO', 'Patentino prodotti fitosanitari', 60],
    ['SICUREZZA_LAVORO', 'Aggiornamento formazione sicurezza', 120],
  ] as const) {
    await compliance.createDeadline({
      tenantId: company.id,
      createdBy: company.admin,
      category,
      title,
      dueDate: isoDay(offset),
    });
  }

  // The other companies of the network; the last one has not answered the invitation yet.
  for (const [i, c] of COMPANIES.entries()) {
    const member = await org(c.name, 'agri', `azienda${i + 1}.demo@sinfonia.test`);
    await join(member.id, member.admin, true);
    await addPractices(member.id, member.admin, c.practices);
  }
  const pending = await org('Fattoria Due Querce', 'agri', 'azienda4.demo@sinfonia.test');
  await join(pending.id, pending.admin, false);

  // The consultant: an external studio, with a delegation from Colle Verde only.
  const studio = await org('Studio Agronomico Demo', 'generic', PILOT_ACCOUNTS.consultant);
  await issueGrant(prisma, {
    grantorOrgId: company.id,
    actorUserId: company.admin,
    grantee: { email: email(PILOT_ACCOUNTS.consultant) },
    operations: ['READ', 'UPDATE'],
    validUntil: new Date(now.getTime() + 180 * DAY_MS),
  });

  return {
    created: true,
    networkId: network.id,
    companyId: company.id,
    consultantOrgId: studio.id,
  };
}
