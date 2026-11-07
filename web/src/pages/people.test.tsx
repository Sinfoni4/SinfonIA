/**
 * FE4: people of the organization (members, roles, revocation, export rights, invitations) and the
 * acceptance of an invitation, against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memberState, tokenFromHash } from '../api/members';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ME = 'u0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });
const failure = (status: number, code: string, message = 'x'): Answer => ({
  status,
  body: { success: false, error: { code, message } },
});

const member = (over: Record<string, unknown> = {}) => ({
  userId: 'u0000000-0000-4000-8000-000000000002',
  role: 'OPERATOR',
  status: 'ACTIVE',
  personStatus: 'ACTIVE',
  email: 'giulia@coop.it',
  since: '2026-09-01T10:00:00.000Z',
  revokedAt: null,
  extraPermissions: [],
  receivesScheduledExport: false,
  ...over,
});

const MEMBERS = [
  member({ userId: ME, role: 'ADMIN', email: 'mario@coop.it' }),
  member(),
  member({ userId: 'u3', role: 'MEMBER', email: null }),
  member({ userId: 'u4', role: 'MEMBER', email: 'ex@coop.it', status: 'REVOKED' }),
];

const invitation = (over: Record<string, unknown> = {}) => ({
  id: 'i0000000-0000-4000-8000-000000000001',
  email: 'nuovo@coop.it',
  role: 'MEMBER',
  status: 'PENDING',
  expiresAt: '2026-11-06T10:00:00.000Z',
  createdAt: '2026-10-30T10:00:00.000Z',
  ...over,
});

let calls: Call[];

function api(role: 'ADMIN' | 'OPERATOR' | 'MEMBER', routes: Record<string, (c: Call) => Answer>) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: ME,
        email: 'mario@coop.it',
        organizations: [{ orgId: ORG, name: 'Cooperativa', role }],
        current: { orgId: ORG, role },
      }),
    'GET /members': () => ok(MEMBERS),
    'GET /roles': () => ok([]),
    'GET /roles/catalog': () => ok({ ADMIN: {}, OPERATOR: {}, MEMBER: {} }),
    'GET /members/invitations': () =>
      ok([invitation(), invitation({ id: 'i2', email: 'vecchio@coop.it', status: 'EXPIRED' })]),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const call: Call = {
        method: init.method ?? 'GET',
        path: url.pathname,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const answer = (routes[key] ?? base[key])?.(call) ?? failure(404, 'NOT_FOUND');
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }),
  );
}

function openAt(path: string, { loggedIn = true } = {}) {
  localStorage.clear();
  if (loggedIn) localStorage.setItem('sinfonia.lastOrganization', ORG);
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

beforeEach(() => vi.unstubAllGlobals());

describe('people helpers', () => {
  it('describes the state of a member in one word', () => {
    expect(memberState({ status: 'ACTIVE', personStatus: 'ACTIVE' })).toEqual({
      label: 'attivo',
      active: true,
    });
    expect(memberState({ status: 'REVOKED', personStatus: 'ACTIVE' }).label).toBe('revocato');
    expect(memberState({ status: 'ACTIVE', personStatus: 'DISABLED' }).label).toBe(
      'account disattivato',
    );
  });

  it('reads the invitation code after #', () => {
    expect(tokenFromHash('#abc-DEF_123')).toBe('abc-DEF_123');
    expect(tokenFromHash('')).toBe('');
  });
});

describe('people (FE4)', () => {
  it('lists members, hides revoked ones until asked, and never edits oneself', async () => {
    api('ADMIN', {});
    openAt('/persone');
    const members = (await screen.findByText('mario@coop.it')).closest('table')!;
    expect(within(members).getByText('tu')).toBeTruthy();
    expect(within(members).getByText('account della chat, senza email')).toBeTruthy();
    expect(within(members).queryByText('ex@coop.it')).toBeNull();
    // Own row: role as text, no revocation.
    const own = within(members).getByText('mario@coop.it').closest('tr')!;
    expect(within(own).queryByRole('combobox')).toBeNull();
    expect(within(own).queryByRole('button', { name: 'Revoca accesso' })).toBeNull();

    await userEvent.click(screen.getByLabelText(/Mostra anche le persone revocate/));
    const revoked = within(members).getByText('ex@coop.it').closest('tr')!;
    expect(within(revoked).getByText('revocato')).toBeTruthy();
    expect(within(revoked).getByRole('button', { name: 'Riattiva' })).toBeTruthy();
  });

  it('changes a role only after confirmation', async () => {
    api('ADMIN', {
      'POST /members/u0000000-0000-4000-8000-000000000002/role': () =>
        ok({ role: 'ADMIN', changed: true }),
    });
    openAt('/persone');
    const select = await screen.findByLabelText('Ruolo di giulia@coop.it');
    await userEvent.selectOptions(select, 'ADMIN');
    expect(posted('/members/u0000000-0000-4000-8000-000000000002/role')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Conferma: amministratore' }));
    await waitFor(() =>
      expect(posted('/members/u0000000-0000-4000-8000-000000000002/role')[0]?.body).toEqual({
        role: 'ADMIN',
      }),
    );
  });

  it('creates a custom role within the base role and gives it to a member', async () => {
    const GIULIA = 'u0000000-0000-4000-8000-000000000002';
    const ROLE = 'r0000000-0000-4000-8000-000000000001';
    api('ADMIN', {
      'GET /roles': () =>
        ok([
          {
            id: ROLE,
            name: 'Segreteria',
            baseRole: 'OPERATOR',
            permissions: { 'practice.read': 'own' },
            members: 0,
          },
        ]),
      'GET /roles/catalog': () =>
        ok({
          ADMIN: { 'practice.read': 'tenant', 'members.manage': 'tenant' },
          OPERATOR: { 'practice.read': 'tenant', 'practice.create': 'own' },
          MEMBER: { 'practice.read': 'own' },
        }),
      'POST /roles': () => ({ status: 201, body: { success: true, data: { id: 'r2' } } }),
      [`POST /members/${GIULIA}/custom-role`]: () => ok({ customRoleId: ROLE }),
    });
    openAt('/persone');
    // Offered only to people whose role is the base of the custom role.
    const pick = await screen.findByLabelText('Ruolo personalizzato di giulia@coop.it');
    expect(screen.queryByLabelText('Ruolo personalizzato di ex@coop.it')).toBeNull();
    await userEvent.selectOptions(pick, ROLE);
    await waitFor(() =>
      expect(posted(`/members/${GIULIA}/custom-role`)[0]?.body).toEqual({ roleId: ROLE }),
    );

    // The new role offers only the permissions of its base, narrowed when asked.
    await userEvent.type(screen.getByLabelText('Nome'), 'Accoglienza');
    expect(screen.queryByText('Gestire persone e ruoli')).toBeNull();
    await userEvent.click(screen.getByLabelText('Vedere le pratiche'));
    // Reading the practices may also cover those assigned to the person.
    const scope = screen.getByLabelText('Ambito di Vedere le pratiche');
    expect(
      within(scope)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(["tutta l'organizzazione", 'proprie e assegnate', 'solo le proprie']);
    await userEvent.selectOptions(scope, 'own');
    await userEvent.click(screen.getByLabelText('Creare pratiche'));
    await userEvent.click(screen.getByRole('button', { name: 'Crea il ruolo' }));
    await waitFor(() =>
      expect(posted('/roles')[0]?.body).toEqual({
        name: 'Accoglienza',
        baseRole: 'OPERATOR',
        permissions: { 'practice.read': 'own', 'practice.create': 'own' },
      }),
    );
  });

  it('opens the card of a member with practices, deadlines and documents', async () => {
    const GIULIA = 'u0000000-0000-4000-8000-000000000002';
    api('ADMIN', {
      [`GET /members/${GIULIA}`]: () =>
        ok({
          userId: GIULIA,
          email: 'giulia@coop.it',
          role: 'OPERATOR',
          customRole: { id: 'r1', name: 'Segreteria' },
          status: 'ACTIVE',
          since: '2026-09-01T10:00:00.000Z',
          practices: {
            total: 3,
            open: 2,
            items: [
              {
                id: 'p1',
                name: 'Domanda PAC',
                status: 'SUBMITTED',
                typeLabel: 'agricultural practice',
                updatedAt: '2026-11-01T10:00:00.000Z',
              },
            ],
          },
          assigned: [],
          deadlines: [
            {
              id: 'd1',
              title: 'Visita medica',
              category: 'VISITA_MEDICA',
              dueDate: '2026-11-15',
              daysLeft: 10,
            },
          ],
          documents: {
            total: 1,
            toReview: 1,
            items: [
              {
                id: 'a1',
                practiceId: 'p1',
                practiceName: 'Domanda PAC',
                fileName: 'fattura.pdf',
                ocrStatus: 'COMPLETED',
                validated: false,
                createdAt: '2026-11-01T10:00:00.000Z',
              },
            ],
          },
        }),
    });
    openAt('/persone');
    await userEvent.click(await screen.findByRole('link', { name: 'giulia@coop.it' }));
    expect(await screen.findByRole('heading', { name: 'giulia@coop.it' })).toBeTruthy();
    expect(screen.getByText('Operatore · Segreteria')).toBeTruthy();
    expect(screen.getByText('3, di cui 2 in corso')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Domanda PAC' }).length).toBe(2);
    expect(screen.getByText('Visita medica')).toBeTruthy();
    expect(screen.getByText('fattura.pdf')).toBeTruthy();
  });

  it('lets an administrator revoke the chat linked to a member (AGX-10)', async () => {
    const GIULIA = 'u0000000-0000-4000-8000-000000000002';
    const LINK = 'c0000000-0000-4000-8000-000000000009';
    api('ADMIN', {
      [`GET /members/${GIULIA}`]: () =>
        ok({
          userId: GIULIA,
          email: 'giulia@coop.it',
          role: 'MEMBER',
          customRole: null,
          status: 'ACTIVE',
          since: '2026-09-01T10:00:00.000Z',
          practices: { total: 0, open: 0, items: [] },
          assigned: [],
          deadlines: [],
          documents: { total: 0, toReview: 0, items: [] },
        }),
      [`GET /members/${GIULIA}/channels`]: () =>
        ok([
          {
            id: LINK,
            channel: 'TELEGRAM',
            ref: '…123',
            linkedAt: '2026-11-07T10:00:00.000Z',
            verified: true,
            lastUsedAt: null,
          },
        ]),
      [`POST /members/${GIULIA}/channels/${LINK}/revoke`]: () => ok({ revoked: true }),
    });
    openAt(`/persone/${GIULIA}`);
    expect(await screen.findByText(/Telegram …123, dal/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scollega' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sì, scollega' }));
    await waitFor(() =>
      expect(posted(`/members/${GIULIA}/channels/${LINK}/revoke`)).toHaveLength(1),
    );
  });

  it('revokes with an optional reason and explains the last-admin refusal', async () => {
    api('ADMIN', {
      'POST /members/u0000000-0000-4000-8000-000000000002/revoke': () => failure(409, 'LAST_ADMIN'),
    });
    openAt('/persone');
    const row = (await screen.findByText('giulia@coop.it')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Revoca accesso' }));
    await userEvent.type(within(row).getByLabelText('Motivo (facoltativo)'), 'fine contratto');
    await userEvent.click(within(row).getByRole('button', { name: 'Conferma revoca' }));
    await waitFor(() =>
      expect(posted('/members/u0000000-0000-4000-8000-000000000002/revoke')[0]?.body).toEqual({
        reason: 'fine contratto',
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/almeno un amministratore/);
  });

  it("grants an OPERATOR the export of the whole organization and turns one's own scheduled export on", async () => {
    api('ADMIN', {
      'POST /members/u0000000-0000-4000-8000-000000000002/permissions': () => ok({}),
      [`POST /members/${ME}/scheduled-export`]: () => ok({}),
    });
    openAt('/persone');
    await userEvent.click(await screen.findByLabelText("tutta l'azienda"));
    await waitFor(() =>
      expect(posted('/members/u0000000-0000-4000-8000-000000000002/permissions')[0]?.body).toEqual({
        permission: 'practice.export',
        granted: true,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Attiva per me' }));
    await waitFor(() =>
      expect(posted(`/members/${ME}/scheduled-export`)[0]?.body).toEqual({ enabled: true }),
    );
  });

  it('lists pending invitations, revokes one after confirmation and sends a new one', async () => {
    api('ADMIN', {
      'POST /members/invitations/i0000000-0000-4000-8000-000000000001/revoke': () => ok({}),
      'POST /members/invitations': () => ok({ invitationId: 'i9', devToken: 'tok-di-prova' }),
    });
    openAt('/persone');
    const row = (await screen.findByText('nuovo@coop.it')).closest('tr')!;
    expect(screen.queryByText('vecchio@coop.it')).toBeNull();
    expect(within(row).getByText('scade il 06/11/2026')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Revoca invito' }));
    await userEvent.click(within(row).getByRole('button', { name: 'Conferma revoca' }));
    await waitFor(() =>
      expect(
        posted('/members/invitations/i0000000-0000-4000-8000-000000000001/revoke'),
      ).toHaveLength(1),
    );

    await userEvent.type(screen.getByLabelText('Email'), 'anna@coop.it');
    await userEvent.selectOptions(screen.getByLabelText('Ruolo'), 'OPERATOR');
    await userEvent.click(screen.getByRole('button', { name: 'Invia invito' }));
    await waitFor(() =>
      expect(posted('/members/invitations')[0]?.body).toEqual({
        email: 'anna@coop.it',
        role: 'OPERATOR',
      }),
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/anna@coop\.it/);
    expect(screen.getByRole('note').textContent).toContain('/app/invito#tok-di-prova');
  });

  it('says when invitations are not available on the server', async () => {
    api('ADMIN', { 'GET /members/invitations': () => failure(404, 'NOT_FOUND') });
    openAt('/persone');
    expect(
      await screen.findByText('Gli inviti per email non sono attivi su questo server.'),
    ).toBeTruthy();
  });

  it('is only for administrators', async () => {
    api('OPERATOR', {});
    openAt('/persone');
    expect(await screen.findByText(/Solo gli amministratori/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Persone' })).toBeNull();
    expect(calls.some((c) => c.path === '/members')).toBe(false);
  });
});

describe('invitation acceptance (P9)', () => {
  it('reads the code from the link, removes it from the address and enters', async () => {
    api('MEMBER', {
      'POST /auth/invitations/start': () => ok({ challengeId: 'c1', devCode: '123456' }),
      'POST /auth/invitations/accept': () =>
        ok({
          userId: ME,
          sessionId: 's',
          organizations: [{ orgId: ORG, name: 'Cooperativa', role: 'MEMBER' }],
        }),
    });
    openAt('/invito#codice-invito-lungo-abbastanza-1234', { loggedIn: false });
    await waitFor(() => expect(window.location.hash).toBe(''));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ricevi il codice di conferma' }),
    );
    expect(posted('/auth/invitations/start')[0]?.body).toEqual({
      token: 'codice-invito-lungo-abbastanza-1234',
    });
    expect((await screen.findByRole('note')).textContent).toContain('123456');
    await userEvent.type(screen.getByLabelText('Codice'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Accetta ed entra' }));
    await waitFor(() =>
      expect(posted('/auth/invitations/accept')[0]?.body).toEqual({
        token: 'codice-invito-lungo-abbastanza-1234',
        challengeId: 'c1',
        code: '123456',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Cooperativa' })).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/app\/?$/);
  });

  it('accepts a pasted code and shows the reason of a refusal', async () => {
    api('MEMBER', {
      'POST /auth/invitations/start': () =>
        failure(409, 'INVITATION_INVALID', 'Invito non valido o scaduto'),
    });
    openAt('/invito', { loggedIn: false });
    await userEvent.type(
      await screen.findByLabelText('Codice invito'),
      'codice-invito-revocato-000000000',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ricevi il codice di conferma' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Invito non valido o scaduto');
  });

  it('is linked from the login page', async () => {
    api('MEMBER', {});
    openAt('/', { loggedIn: false });
    await userEvent.click(await screen.findByRole('link', { name: "Accetta l'invito" }));
    expect(await screen.findByRole('heading', { name: "Accetta l'invito" })).toBeTruthy();
  });
});
