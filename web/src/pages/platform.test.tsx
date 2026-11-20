/**
 * FE7: the platform console in the dashboard (entry, organizations, new organization and
 * suspension with a confirmation code, platform log), against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describePlatformAction, type PlatformAuditRow } from '../api/platform';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });
const failure = (status: number, code: string, message = 'x'): Answer => ({
  status,
  body: { success: false, error: { code, message } },
});

const ROW = {
  id: ORG,
  name: 'Cooperativa Alfa',
  type: 'COOPERATIVE',
  status: 'ACTIVE',
  module: 'music',
  createdAt: '2026-10-01T10:00:00Z',
  members: 4,
  practices: 12,
  lastActivityAt: '2026-10-30T10:00:00Z',
};

const DETAIL = {
  ...ROW,
  scheduledExport: false,
  webhook: false,
  deactivatedAt: null,
  administrators: [{ email: 'admin@alfa.it', since: '2026-10-01T10:00:00Z' }],
  pendingInvitations: 0,
};

let calls: Call[];

function api(routes: Record<string, (c: Call) => Answer>) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/platform-token': () => ok({ accessToken: 'ptok', expiresIn: 600 }),
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'gestore@sinfonia.it',
        organizations: [{ orgId: ORG, name: 'Cooperativa Alfa', role: 'ADMIN' }],
        platform: true,
        current: { orgId: ORG, role: 'ADMIN' },
      }),
    'GET /platform/me': () =>
      ok({
        userId: 'u-1',
        email: 'gestore@sinfonia.it',
        organizations: [{ orgId: ORG, name: 'Cooperativa Alfa', role: 'ADMIN' }],
      }),
    'GET /platform/organizations': () => ok({ items: [ROW], total: 1, page: 1, totalPages: 1 }),
    [`GET /platform/organizations/${ORG}`]: () => ok(DETAIL),
    'POST /platform/verification': () => ok({ challengeId: 'c-1', devCode: '654321' }),
    'GET /dashboard/summary': () =>
      ok({
        practices: {
          total: 0,
          byStatus: { CREATED: 0, VALIDATED: 0, SUBMITTED: 0, FAILED: 0, COMPLETED: 0 },
        },
        deadlines: { overdue: 0, dueSoon: 0, upcoming: [] },
        documents: { toReview: 0, unreadable: 0, items: [] },
        recentPractices: [],
      }),
    'GET /audit': () => ok({ items: [], total: 0, page: 1, limit: 10, totalPages: 0 }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const call: Call = {
        method: init.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const answer = (routes[key] ?? base[key])?.(call) ?? failure(404, 'NOT_FOUND');
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }),
  );
}

function openAt(path: string, last: string) {
  localStorage.clear();
  localStorage.setItem('sinfonia.lastOrganization', last);
  window.history.pushState({}, '', `/app${path}`);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BrowserRouter basename="/app">
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const tokenOf = (path: string) => {
  const call = vi.mocked(fetch).mock.calls.find(([url]) => (url as string).startsWith(path));
  const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
  return headers.authorization;
};

beforeEach(() => vi.unstubAllGlobals());

describe('platform helpers', () => {
  it('describes platform actions in Italian', () => {
    const row = (over: Partial<PlatformAuditRow>): PlatformAuditRow => ({
      id: 'r',
      at: '2026-10-31T10:00:00Z',
      action: 'ORGANIZATION_CREATED',
      actorEmail: 'gestore@sinfonia.it',
      organization: { id: ORG, name: 'Cooperativa Alfa' },
      targetEmail: null,
      details: {},
      ...over,
    });
    expect(describePlatformAction(row({ details: { type: 'COOPERATIVE' } }))).toBe(
      "Creata l'organizzazione «Cooperativa Alfa» (cooperativa)",
    );
    expect(
      describePlatformAction(
        row({ action: 'ORGANIZATION_SUSPENDED', details: { reason: 'Contratto scaduto' } }),
      ),
    ).toBe('Sospesa «Cooperativa Alfa»: Contratto scaduto');
    expect(
      describePlatformAction(
        row({ action: 'PLATFORM_ADMIN_GRANTED', organization: null, targetEmail: 'b@s.it' }),
      ),
    ).toBe('b@s.it è ora gestore della piattaforma');
  });
});

describe('platform console (FE7)', () => {
  it('opens from the header of an organization, with a token of its own', async () => {
    api({});
    openAt('/', ORG);
    await userEvent.click(await screen.findByRole('button', { name: 'Console' }));
    expect(await screen.findByText('Console di piattaforma')).toBeTruthy();
    expect(posted('/auth/platform-token')).toHaveLength(1);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Cooperativa Alfa' })).toBeTruthy();
    expect(within(table).getByText('Cooperativa')).toBeTruthy();
    expect(tokenOf('/platform/organizations')).toBe('Bearer ptok');
    expect(localStorage.getItem('sinfonia.lastOrganization')).toBe('platform');
  });

  it('shows the sector of each organization and filters the list by it', async () => {
    api({});
    openAt('/piattaforma', 'platform');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Musica e spettacolo')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Settore'), 'agri');
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === '/platform/organizations' && c.query.get('module') === 'agri'),
      ).toBe(true),
    );
  });

  it('turns functions on and off from the table, those of a sector only for it', async () => {
    const farm = {
      ...ROW,
      module: 'agri',
      disabledFeatures: ['assistance'],
      enabledFeatures: ['field_book'],
      miniAppFeatures: [],
    };
    api({
      'GET /platform/features': () =>
        ok({
          common: [
            { id: 'ai_chat', label: 'Assistente IA nella chat' },
            { id: 'assistance', label: 'Richieste di assistenza' },
          ],
          sector: [
            {
              id: 'field_book',
              label: 'Quaderno di campagna',
              description: 'Registro dei trattamenti.',
              modules: ['agri'],
              ready: false,
            },
            {
              id: 'grants',
              label: 'Bandi e contributi',
              description: 'Bandi.',
              modules: ['artisan'],
              ready: false,
            },
          ],
        }),
      'GET /platform/organizations': () => ok({ items: [farm], total: 1, page: 1, totalPages: 1 }),
      [`PATCH /platform/organizations/${ORG}/features/assistance`]: () =>
        ok({ disabledFeatures: [], enabledFeatures: ['field_book'], miniAppFeatures: [] }),
      [`PATCH /platform/organizations/${ORG}/features/field_book`]: () =>
        ok({ disabledFeatures: [], enabledFeatures: ['field_book'], miniAppFeatures: [] }),
    });
    openAt('/piattaforma/funzioni', 'platform');
    const book = await screen.findByRole('checkbox', {
      name: 'Quaderno di campagna nella dashboard per Cooperativa Alfa',
    });
    expect((book as HTMLInputElement).checked).toBe(true);
    // The Mini App is chosen apart.
    const bookInApp = screen.getByRole('checkbox', {
      name: 'Quaderno di campagna nella Mini App per Cooperativa Alfa',
    });
    expect((bookInApp as HTMLInputElement).checked).toBe(false);
    await userEvent.click(bookInApp);
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === 'PATCH' && c.path === `/platform/organizations/${ORG}/features/field_book`,
        )?.body,
      ).toEqual({ enabled: true, channel: 'miniapp' }),
    );
    expect(screen.getAllByText('in preparazione').length).toBeGreaterThan(0);
    // A function of another sector is not offered to this organization.
    expect(screen.queryByRole('checkbox', { name: /Bandi e contributi/ })).toBeNull();
    const assistance = screen.getByRole('checkbox', {
      name: 'Richieste di assistenza per Cooperativa Alfa',
    });
    expect((assistance as HTMLInputElement).checked).toBe(false);
    await userEvent.click(assistance);
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === 'PATCH' && c.path === `/platform/organizations/${ORG}/features/assistance`,
        )?.body,
      ).toEqual({ enabled: true }),
    );
  });

  it('resumes the console after a reload and goes back to the organization', async () => {
    api({});
    openAt('/piattaforma', 'platform');
    await userEvent.click(await screen.findByRole('button', { name: 'Le mie aziende' }));
    expect(await screen.findByRole('heading', { name: 'Cooperativa Alfa' })).toBeTruthy();
    expect(posted('/auth/token')).toHaveLength(1);
  });

  it('asks for a new login when the console needs a recent code', async () => {
    api({
      'POST /auth/platform-token': () =>
        failure(401, 'PLATFORM_REAUTH', 'Per la console serve un accesso recente'),
    });
    openAt('/piattaforma', 'platform');
    expect(await screen.findByRole('button', { name: 'Ricevi il codice di accesso' })).toBeTruthy();
  });

  it('creates an organization only with the confirmation code', async () => {
    api({
      'POST /platform/organizations': () =>
        ok({ orgId: ORG, invitationId: 'i-1', devToken: 'tok-invito' }),
    });
    openAt('/piattaforma/nuova', 'platform');
    await userEvent.type(await screen.findByLabelText('Nome'), 'Cooperativa Alfa');
    await userEvent.selectOptions(screen.getByLabelText('Tipo'), 'COOPERATIVE');
    await userEvent.type(screen.getByLabelText('Email del primo amministratore'), 'admin@alfa.it');
    const create = screen.getByRole('button', { name: "Crea e invia l'invito" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(
      screen.getByRole('button', { name: 'Invia il codice di conferma alla mia email' }),
    );
    expect((await screen.findByRole('note')).textContent).toContain('654321');
    await userEvent.type(screen.getByLabelText('Codice di conferma'), '654321');
    await userEvent.click(create);
    await waitFor(() =>
      expect(posted('/platform/organizations')[0]?.body).toEqual({
        name: 'Cooperativa Alfa',
        type: 'COOPERATIVE',
        module: 'generic',
        firstAdminEmail: 'admin@alfa.it',
        verification: { challengeId: 'c-1', code: '654321' },
      }),
    );
    expect((await screen.findByRole('status')).textContent).toContain('admin@alfa.it');
    expect(screen.getByRole('note').textContent).toContain('/app/invito#tok-invito');
  });

  it('suspends with a reason and a code, showing only counts and administrators', async () => {
    api({
      [`POST /platform/organizations/${ORG}/suspend`]: () => ok({ status: 'SUSPENDED' }),
    });
    openAt(`/piattaforma/organizzazioni/${ORG}`, 'platform');
    expect(await screen.findByText('admin@alfa.it')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sospendi…' }));
    await userEvent.type(screen.getByLabelText('Motivo'), 'Contratto scaduto');
    const confirm = screen.getByRole('button', { name: 'Conferma sospensione' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(
      screen.getByRole('button', { name: 'Invia il codice di conferma alla mia email' }),
    );
    await userEvent.type(await screen.findByLabelText('Codice di conferma'), '654321');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(posted(`/platform/organizations/${ORG}/suspend`)[0]?.body).toEqual({
        reason: 'Contratto scaduto',
        verification: { challengeId: 'c-1', code: '654321' },
      }),
    );
  });

  it('uploads the logo of the Mini App and previews it on the dark grey', async () => {
    let logo: unknown = null;
    api({
      [`GET /platform/organizations/${ORG}/logo`]: () => ok(logo),
      [`POST /platform/organizations/${ORG}/logo`]: (c) => {
        const body = c.body as { contentType: string; data: string };
        logo = { ...body, updatedAt: '2026-11-19T18:00:00Z' };
        return ok({ logoUpdatedAt: '2026-11-19T18:00:00Z' });
      },
    });
    openAt(`/piattaforma/organizzazioni/${ORG}`, 'platform');
    expect(await screen.findByText(/Nessun logo/)).toBeTruthy();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
    await userEvent.upload(
      screen.getByLabelText('Nuovo logo'),
      new File([svg], 'logo.svg', { type: 'image/svg+xml' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Carica il logo' }));
    await waitFor(() =>
      expect(posted(`/platform/organizations/${ORG}/logo`)[0]?.body).toEqual({
        contentType: 'image/svg+xml',
        data: btoa(svg),
      }),
    );
    const img = await screen.findByRole('img', { name: 'Logo attuale' });
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;base64,${btoa(svg)}`);
    expect(screen.getByRole('button', { name: 'Togli il logo' })).toBeTruthy();
  });

  it('sets the identifiers of a company, with the codes in other systems', async () => {
    api({
      [`GET /platform/organizations/${ORG}`]: () =>
        ok({
          ...DETAIL,
          identifiers: { taxCode: null, vatNumber: '12345678903', externalRefs: {} },
        }),
      [`PATCH /platform/organizations/${ORG}/identifiers`]: (c) => ok(c.body),
    });
    openAt(`/piattaforma/organizzazioni/${ORG}`, 'platform');
    const vat = await screen.findByLabelText<HTMLInputElement>('Partita IVA');
    expect(vat.value).toBe('12345678903');
    await userEvent.type(screen.getByLabelText('Codice fiscale / CUAA'), '12345678903');
    const refs = screen.getByLabelText('Riferimenti in altri sistemi');
    await userEvent.type(refs, 'odoo res.partner');
    expect((await screen.findByRole('alert')).textContent).toContain('sistema = riferimento');
    const save = screen.getByRole('button', { name: 'Salva dati identificativi' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(refs);
    await userEvent.type(refs, 'odoo = res.partner/42');
    await userEvent.click(save);
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === 'PATCH' && c.path === `/platform/organizations/${ORG}/identifiers`,
        )?.body,
      ).toEqual({
        taxCode: '12345678903',
        vatNumber: '12345678903',
        externalRefs: { odoo: 'res.partner/42' },
      }),
    );
  });

  it('invites a company into a network from the console', async () => {
    const COMPANY = 'a0000000-0000-4000-8000-000000000009';
    api({
      [`GET /platform/organizations/${ORG}`]: () => ok({ ...DETAIL, type: 'NETWORK' }),
      [`GET /platform/organizations/${ORG}/links`]: () =>
        ok({ isNetwork: true, members: [], networks: [] }),
      'GET /platform/organizations': () =>
        ok({
          items: [ROW, { ...ROW, id: COMPANY, name: 'Azienda Agricola Beta', type: 'COMPANY' }],
          total: 2,
          page: 1,
          totalPages: 1,
        }),
      [`POST /platform/organizations/${ORG}/network-members`]: () => ({
        status: 201,
        body: { success: true, data: { relationId: 'r-1' } },
      }),
    });
    openAt(`/piattaforma/organizzazioni/${ORG}`, 'platform');
    expect(await screen.findByText('Nessuna azienda.')).toBeTruthy();
    const select = screen.getByLabelText('Azienda');
    // The network itself is not offered.
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Scegli…', 'Azienda Agricola Beta']),
    );
    await userEvent.selectOptions(select, COMPANY);
    await userEvent.click(screen.getByRole('button', { name: 'Invita nella rete' }));
    expect(await screen.findByText(/deve confermarlo/)).toBeTruthy();
    expect(posted(`/platform/organizations/${ORG}/network-members`)[0]?.body).toEqual({
      orgId: COMPANY,
    });
  });

  it('shows the usage with the internal cost, and reverses an event with a reason', async () => {
    const EVENT = 'e0000000-0000-4000-8000-000000000001';
    api({
      'GET /platform/usage': () =>
        ok({
          period: { kind: 'month', previous: false, from: '2026-11-01', to: '2026-11-30' },
          ratesConfigured: true,
          rates: { OCR_PAGES: 0.01 },
          organizations: [
            {
              orgId: ORG,
              orgName: 'Azienda Agricola Alfa',
              items: [{ kind: 'OCR_PAGES', quantity: 12, cost: 0.12 }],
              cost: 0.12,
            },
          ],
          totals: [{ kind: 'OCR_PAGES', unit: 'page', quantity: 12, cost: 0.12 }],
          cost: 0.12,
          recent: [
            {
              id: EVENT,
              orgId: ORG,
              orgName: 'Azienda Agricola Alfa',
              actorOrgName: 'TerreFVG',
              kind: 'OCR_PAGES',
              quantity: 12,
              unit: 'page',
              occurredAt: '2026-11-07T10:00:00Z',
              correctionOf: null,
              reversed: false,
              reason: null,
            },
          ],
        }),
      [`POST /platform/usage/${EVENT}/reverse`]: () => ({
        status: 201,
        body: { success: true, data: { id: 'r', correctionOf: EVENT, quantity: -12 } },
      }),
    });
    openAt('/piattaforma/consumi', 'platform');
    expect(await screen.findByText(/Costo interno stimato/)).toBeTruthy();
    expect(screen.getByText('Azienda Agricola Alfa (da TerreFVG)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Storna' }));
    await userEvent.type(screen.getByLabelText('Motivo dello storno'), 'Documento di prova');
    await userEvent.click(screen.getByRole('button', { name: 'Storna' }));
    await waitFor(() =>
      expect(posted(`/platform/usage/${EVENT}/reverse`)[0]?.body).toEqual({
        reason: 'Documento di prova',
      }),
    );
  });

  it('is not offered to people who are not platform administrators', async () => {
    api({
      'GET /auth/me': () =>
        ok({
          userId: 'u-2',
          email: 'mario@coop.it',
          organizations: [{ orgId: ORG, name: 'Cooperativa Alfa', role: 'ADMIN' }],
          platform: false,
          current: { orgId: ORG, role: 'ADMIN' },
        }),
    });
    openAt('/', ORG);
    await screen.findByRole('heading', { name: 'Cooperativa Alfa' });
    expect(screen.queryByRole('button', { name: 'Console' })).toBeNull();
  });
});
