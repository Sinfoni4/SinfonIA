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
  createdAt: '2026-10-01T10:00:00Z',
  members: 4,
  practices: 12,
  lastActivityAt: '2026-10-30T10:00:00Z',
};

const DETAIL = {
  ...ROW,
  module: 'music',
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
