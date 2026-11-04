/**
 * MF9: members and statistics of a network, memberships of a company, against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showProtected } from '../api/network';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const COMPANY = 'c0000000-0000-4000-8000-000000000002';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const STATS = {
  period: { kind: 'month', previous: false, from: '2026-11-01', to: '2026-11-30' },
  members: { inPeriod: 6, activeNow: 6, threshold: 5, sufficient: true },
  practicesByStatus: [{ status: 'CREATED', value: 8 }],
  practicesByKind: [
    { kind: 'agri', value: null },
    { kind: 'generic', value: 6 },
  ],
  completionDays: [],
  deadlines: [{ category: 'DURC', overdue: 'lt3', dueSoon: 0 }],
  organic: { valid: 5, total: 6 },
  documents: { uploaded: 12, readWithoutCheckPercent: 75 },
  channels: { chatRequests: 40, dashboardLogins: 9 },
};

let calls: Call[];

function api(
  role: 'ADMIN' | 'OPERATOR' | 'MEMBER',
  type: string,
  routes: Record<string, (c: Call) => Answer> = {},
) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'anna@terre.it',
        organizations: [{ orgId: ORG, name: 'TerreFVG', role, type }],
        platform: false,
        current: { orgId: ORG, role },
      }),
    'GET /network/members': () =>
      ok([
        {
          relationId: 'r-1',
          orgId: COMPANY,
          name: 'Azienda Agricola Collio',
          type: 'COMPANY',
          municipality: 'Cormons',
          sector: 'Viticoltura',
          status: 'ACTIVE',
          invitedAt: '2026-11-01T10:00:00Z',
          startedAt: '2026-11-02T10:00:00Z',
        },
      ]),
    'GET /network/stats': () => ok(STATS),
    'GET /memberships': () =>
      ok([
        {
          relationId: 'r-9',
          networkId: 'n-1',
          name: 'TerreFVG',
          type: 'NETWORK',
          status: 'PENDING',
          invitedAt: '2026-11-04T10:00:00Z',
          startedAt: null,
        },
      ]),
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
      const answer = (routes[key] ?? base[key])?.(call) ?? {
        status: 404,
        body: { success: false, error: { code: 'NOT_FOUND', message: 'x' } },
      };
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }),
  );
}

function openAt(path: string) {
  localStorage.clear();
  localStorage.setItem('sinfonia.lastOrganization', ORG);
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

beforeEach(() => vi.unstubAllGlobals());

describe('networks (MF9)', () => {
  it('writes protected values as the D4 rules say', () => {
    expect(showProtected(null)).toBe('non disponibile');
    expect(showProtected('lt3')).toBe('meno di 3');
    expect(showProtected(12500)).toBe('12.500');
    expect(showProtected(75, '%')).toBe('75%');
  });

  it('shows a network its members with the minimal profile, and invites by code', async () => {
    api('ADMIN', 'NETWORK', { 'POST /network/members': () => ok({ relationId: 'r-2' }) });
    openAt('/rete');
    expect(await screen.findByText(/Azienda Agricola Collio/)).toBeTruthy();
    expect(screen.getByText('Cormons')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Aderenti' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Codice di adesione/), COMPANY);
    await userEvent.click(screen.getByRole('button', { name: 'Invita' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/network/members')?.body).toEqual(
        { orgId: COMPANY },
      ),
    );
  });

  it('shows the statistics with «meno di 3» and «non disponibile»', async () => {
    api('OPERATOR', 'NETWORK');
    openAt('/rete/statistiche');
    expect(await screen.findByText('Statistiche della rete')).toBeTruthy();
    expect(await screen.findByText('meno di 3 scadute · 0 entro 30 giorni')).toBeTruthy();
    expect(screen.getByText('non disponibile')).toBeTruthy();
    expect(screen.getByText('5 su 6')).toBeTruthy();
  });

  it('hides the network sections from a company, which confirms an invitation instead', async () => {
    api('ADMIN', 'COMPANY', { 'POST /memberships/r-9/confirm': () => ok({ status: 'ACTIVE' }) });
    openAt('/adesioni');
    const confirm = await screen.findByRole('button', { name: "Conferma l'adesione" });
    expect(screen.queryByRole('link', { name: 'Aderenti' })).toBeNull();
    expect(screen.getByText(ORG)).toBeTruthy();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/memberships/r-9/confirm')).toBe(true),
    );
  });
});
