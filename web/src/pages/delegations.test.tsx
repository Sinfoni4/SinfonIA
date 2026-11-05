/**
 * MF8: delegations given and received, and the work on delegated practices, against a simulated
 * API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { endDateIn, maxMonths } from '../api/delegations';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const COMPANY = 'c0000000-0000-4000-8000-000000000002';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

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
    'GET /grants/issued': () =>
      ok([
        {
          id: 'g-1',
          granteeType: 'ORGANIZATION',
          grantee: { orgId: 'n-1', name: 'TerreFVG', type: 'NETWORK' },
          operations: ['READ', 'UPDATE'],
          validFrom: '2026-11-01T10:00:00Z',
          validUntil: '2027-05-01T10:00:00Z',
          state: 'ACTIVE',
          revokedAt: null,
          beneficiaries: [{ userId: 'u-7', email: 'segreteria@terre.it', status: 'PROPOSED' }],
        },
      ]),
    'GET /grants/received': () =>
      ok([
        {
          id: 'g-2',
          grantor: { orgId: COMPANY, name: 'Azienda Agricola Collio' },
          granteeType: 'ORGANIZATION',
          operations: ['READ', 'UPDATE'],
          validUntil: '2027-05-01T10:00:00Z',
          state: 'ACTIVE',
          usable: true,
          beneficiaries: [],
        },
      ]),
    'GET /members': () => ok([]),
    'GET /grants/g-2/practices': () =>
      ok({
        items: [
          {
            id: 'p-1',
            userId: 'u-9',
            status: 'CREATED',
            name: 'Fascicolo aziendale',
            kind: 'generic',
            typeLabel: 'pratica',
            summary: '',
            createdAt: '2026-11-01T10:00:00Z',
            updatedAt: '2026-11-02T10:00:00Z',
            assignedTo: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
        delegation: {
          grantorName: 'Azienda Agricola Collio',
          operations: ['READ', 'UPDATE'],
          validUntil: '2027-05-01T10:00:00Z',
        },
      }),
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

describe('delegations (MF8)', () => {
  it('limits the duration as D3 says', () => {
    expect(maxMonths(['READ', 'UPDATE'])).toBe(12);
    expect(maxMonths(['READ', 'EXPORT'])).toBe(3);
    expect(endDateIn(3, new Date(2026, 10, 5))).toBe('2027-02-05');
  });

  it('gives a delegation to an organization and approves the person it names', async () => {
    api('ADMIN', 'COMPANY', {
      'POST /grants': () => ({ status: 201, body: { success: true, data: { id: 'g-9' } } }),
      'POST /grants/g-1/beneficiaries/approve': () => ok({ done: true }),
    });
    openAt('/deleghe');
    expect(await screen.findByText('segreteria@terre.it · da approvare')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approva' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/grants/g-1/beneficiaries/approve')?.body).toEqual({
        userId: 'u-7',
      }),
    );
    await userEvent.type(screen.getByLabelText("Codice dell'organizzazione"), COMPANY);
    await userEvent.click(screen.getByLabelText('esportare le pratiche'));
    await userEvent.click(screen.getByRole('button', { name: 'Concedi la delega' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/grants')?.body).toEqual({
        grantee: { orgId: COMPANY },
        operations: ['READ', 'EXPORT'],
        // With export, at most 3 months.
        validUntil: endDateIn(3),
      }),
    );
  });

  it('opens the practices of the grantor with its name always in view', async () => {
    api('OPERATOR', 'NETWORK', {
      'POST /grants/g-2/practices/p-1/transition': () => ok({ id: 'p-1', status: 'VALIDATED' }),
    });
    openAt('/deleghe');
    await userEvent.click(
      await screen.findByRole('link', { name: 'Apri le pratiche di Azienda Agricola Collio' }),
    );
    expect(await screen.findByText(/Stai lavorando sui dati di/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Esporta CSV' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Valida' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/grants/g-2/practices/p-1/transition')?.body).toEqual({
        nextState: 'VALIDATED',
      }),
    );
  });
});
