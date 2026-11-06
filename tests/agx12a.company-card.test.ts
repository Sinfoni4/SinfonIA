/**
 * AGX-12a: «🏢 La mia azienda» in chat. Everyone sees the profile of the company and the counts
 * within their own grants; codice fiscale / CUAA and partita IVA reach who manages the
 * organization only, masked, and the full codes are a separate request recorded in the audit
 * without their values. Nothing of it goes through the AI.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ComplianceService } from '../src/core/compliance/compliance.service.js';
import {
  getCompanyCard,
  maskCode,
  revealCompanyIdentifiers,
  type CompanyCard,
} from '../src/core/organization/company-card.service.js';
import { PracticeApplicationService } from '../src/core/practice/practice.application.service.js';
import { createPrismaClient } from '../src/data/db/prisma.js';
import { TenantRepository } from '../src/data/repositories/tenant.repository.js';
import { UserRepository } from '../src/data/repositories/user.repository.js';
import {
  ConversationService,
  formatCompanyCard,
  MENU_BUTTONS,
  type ReplyOptions,
} from '../src/interface/conversation/conversation.service.js';

import type { Principal } from '../src/core/authz/authorization.service.js';
import type { Tenant } from '../src/core/tenant/tenant.store.js';
import type { PrismaClient, UserRole } from '@prisma/client';

const PERSON_CODE = 'RSSMRA85T10A562S';
const VAT = '12345678903';

describe('masking the codes', () => {
  it('keeps the first 3 and last 4 characters', () => {
    expect(maskCode(PERSON_CODE)).toBe('RSS•••••••••562S');
    expect(maskCode(VAT)).toBe('123••••8903');
    expect(maskCode(null)).toBeNull();
    expect(maskCode('ABC')).toBe('•••');
  });
});

const CARD: CompanyCard = {
  name: 'Azienda Agricola Prova',
  type: 'COMPANY',
  municipality: 'Cormons',
  sector: 'Viticoltura',
  networks: ['Rete TerreFVG'],
  openPractices: 3,
  nextDeadline: { title: 'DURC', dueDate: '2026-11-20', daysLeft: 14 },
  identifiers: { taxCode: maskCode(PERSON_CODE), vatNumber: null },
};

describe('the card in chat', () => {
  it('shows profile, counts and the masked codes', () => {
    const text = formatCompanyCard(CARD, 'ADMIN');
    expect(text).toContain('🏢 Lavori per Azienda Agricola Prova come amministratore.');
    expect(text).toContain('Comune: Cormons');
    expect(text).toContain('Reti: Rete TerreFVG');
    expect(text).toContain('📁 Pratiche aperte: 3');
    expect(text).toContain('⏰ Prossima scadenza: DURC, 20/11/2026 (tra 14 giorni)');
    expect(text).toContain('Codice fiscale / CUAA: RSS•••••••••562S');
    expect(text).toContain('Partita IVA: non inserita');
    expect(text).not.toContain(PERSON_CODE);
  });

  it('leaves out what is missing or not allowed', () => {
    const text = formatCompanyCard(
      {
        ...CARD,
        municipality: null,
        networks: [],
        openPractices: null,
        nextDeadline: null,
        identifiers: null,
      },
      'MEMBER',
    );
    expect(text).toContain('come collaboratore');
    expect(text).not.toMatch(/Comune|Reti|Pratiche|scadenza|Codice fiscale|Partita IVA/);
  });

  it('is in the main menu', () => {
    expect(MENU_BUTTONS.map((b) => b.label)).toContain('🏢 La mia azienda');
  });
});

describe('the card in the conversation', () => {
  function chat(
    role: UserRole,
    card: CompanyCard,
    codes = { taxCode: PERSON_CODE, vatNumber: VAT },
  ) {
    const tenant = { id: 't-1', name: CARD.name, disabledFeatures: [] } as unknown as Tenant;
    const companyCard = vi.fn().mockResolvedValue(card);
    const revealCompanyIdentifiers = vi.fn((actor: Principal) =>
      Promise.resolve(actor.role === 'ADMIN' ? codes : null),
    );
    const handleMessage = vi.fn().mockResolvedValue('risposta AI');
    const service = new ConversationService(
      {
        practiceService: { executeCommand: vi.fn() },
        handleMessage,
        companyCard,
        revealCompanyIdentifiers,
      },
      {
        name: 'telegram',
        identity: {
          link: () => Promise.resolve(null),
          resolve: () => Promise.resolve({ tenant, userId: 'u-1', role, customPermissions: null }),
        },
      },
    );
    const sent: Array<{ text: string; options?: ReplyOptions }> = [];
    const say = (text: string) =>
      service.handle({ senderId: '1', text }, (t, options) => {
        sent.push({ text: t, options });
        return Promise.resolve();
      });
    return { say, sent, companyCard, revealCompanyIdentifiers, handleMessage };
  }

  it('answers the menu entry and «azienda» without the AI, with the reveal button for admins', async () => {
    const c = chat('ADMIN', CARD);
    await c.say('🏢 La mia azienda');
    await c.say('azienda');
    expect(c.sent).toHaveLength(2);
    expect(c.sent[0].text).toContain('RSS•••••••••562S');
    expect(c.sent[0].options?.buttons).toEqual([
      { label: '🔓 Mostra per intero', answer: 'mostra codici' },
    ]);
    expect(c.companyCard).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't-1', userId: 'u-1', role: 'ADMIN' }),
    );
    expect(c.handleMessage).not.toHaveBeenCalled();
  });

  it('sends the full codes only to who manages the organization', async () => {
    const admin = chat('ADMIN', CARD);
    await admin.say('mostra codici');
    expect(admin.sent[0].text).toContain(`Codice fiscale / CUAA: ${PERSON_CODE}`);
    expect(admin.sent[0].text).toContain(`Partita IVA: ${VAT}`);
    expect(admin.revealCompanyIdentifiers).toHaveBeenCalledWith(expect.anything(), 'telegram');

    const member = chat('MEMBER', { ...CARD, identifiers: null });
    await member.say('🏢 La mia azienda');
    expect(member.sent[0].options).toBeUndefined();
    await member.say('mostra codici');
    expect(member.sent[1].text).toContain('Solo gli amministratori');
    expect(member.sent.map((s) => s.text).join()).not.toContain(PERSON_CODE);
    expect(member.handleMessage).not.toHaveBeenCalled();
  });

  it('offers no reveal when no code is entered', async () => {
    const c = chat('ADMIN', { ...CARD, identifiers: { taxCode: null, vatNumber: null } });
    await c.say('la mia azienda');
    expect(c.sent[0].options).toBeUndefined();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))('company card with PostgreSQL (AGX-12a)', () => {
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaClient;
  let compliance: ComplianceService;
  let orgId = '';
  const people: Record<'admin' | 'member' | 'colleague', string> = {
    admin: '',
    member: '',
    colleague: '',
  };
  const principal = (who: keyof typeof people, role: UserRole): Principal => ({
    tenantId: orgId,
    userId: people[who],
    role,
    customPermissions: null,
  });

  beforeAll(async () => {
    prisma = createPrismaClient(DATABASE_URL!);
    await prisma.$connect();
    compliance = new ComplianceService(prisma);
    const tenants = new TenantRepository(prisma);
    orgId = (await tenants.createTenant({ name: `agx12a-azienda-${run}` })).id;
    await prisma.tenant.update({
      where: { id: orgId },
      data: { municipality: 'Cormons', taxCode: PERSON_CODE, vatNumber: VAT },
    });
    const networkId = (await tenants.createTenant({ name: `agx12a-rete-${run}` })).id;
    const endedId = (await tenants.createTenant({ name: `agx12a-uscita-${run}` })).id;
    await prisma.tenant.updateMany({
      where: { id: { in: [networkId, endedId] } },
      data: { type: 'NETWORK' },
    });
    await prisma.organizationRelation.createMany({
      data: [
        { parentOrgId: networkId, childOrgId: orgId, status: 'ACTIVE' },
        { parentOrgId: endedId, childOrgId: orgId, status: 'ENDED' },
      ],
    });
    const users = new UserRepository(prisma);
    people.admin = (
      await users.createUser(orgId, { email: `admin-${run}@agx12a.local`, role: 'ADMIN' })
    ).id;
    people.member = (
      await users.createUser(orgId, { email: `socio-${run}@agx12a.local`, role: 'MEMBER' })
    ).id;
    people.colleague = (
      await users.createUser(orgId, { email: `collega-${run}@agx12a.local`, role: 'MEMBER' })
    ).id;
    const practices = new PracticeApplicationService(prisma);
    await practices.createPractice({ tenantId: orgId, userId: people.member, name: `Mia ${run}` });
    await practices.createPractice({
      tenantId: orgId,
      userId: people.colleague,
      name: `Collega ${run}`,
    });
    await compliance.createDeadline({
      tenantId: orgId,
      createdBy: people.admin,
      userId: people.colleague,
      title: 'DURC collega',
      category: 'DURC',
      dueDate: '2030-01-31',
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('gives the administrator the whole company and the masked codes', async () => {
    const card = await getCompanyCard(prisma, compliance, principal('admin', 'ADMIN'));
    expect(card).toMatchObject({
      name: `agx12a-azienda-${run}`,
      municipality: 'Cormons',
      networks: [`agx12a-rete-${run}`],
      openPractices: 2,
      nextDeadline: { title: 'DURC collega', dueDate: '2030-01-31' },
      identifiers: { taxCode: 'RSS•••••••••562S', vatNumber: '123••••8903' },
    });
  });

  it('gives a member their own counts and no codes', async () => {
    const card = await getCompanyCard(prisma, compliance, principal('member', 'MEMBER'));
    expect(card.openPractices).toBe(1);
    expect(card.nextDeadline).toBeNull();
    expect(card.identifiers).toBeNull();
    expect(JSON.stringify(card)).not.toContain('8903');
  });

  it('reveals the codes to the administrator only, recording it without the values', async () => {
    expect(await revealCompanyIdentifiers(prisma, principal('member', 'MEMBER'), 'telegram')).toBe(
      null,
    );
    expect(await revealCompanyIdentifiers(prisma, principal('admin', 'ADMIN'), 'telegram')).toEqual(
      { taxCode: PERSON_CODE, vatNumber: VAT },
    );
    const events = await prisma.auditLog.findMany({
      where: { tenantId: orgId, eventType: 'COMPANY_IDENTIFIERS_VIEWED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: people.admin, payload: { channel: 'telegram' } });
  });
});
