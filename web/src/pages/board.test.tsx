/**
 * A4: the board of practices (one column per state), with assignment and moves, against a
 * simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { boardQuery } from '../api/practices';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const PRACTICE = {
  id: 'p0000000-0000-4000-8000-000000000001',
  userId: 'u-2',
  status: 'CREATED',
  name: 'Vendemmia 2026',
  kind: 'generic',
  typeLabel: 'pratica',
  summary: '',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
  assignedTo: null,
};

let calls: Call[];

function api(
  role: 'ADMIN' | 'OPERATOR' | 'MEMBER',
  routes: Record<string, (c: Call) => Answer> = {},
) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'anna@coop.it',
        organizations: [{ orgId: ORG, name: 'Cooperativa', role }],
        platform: false,
        current: { orgId: ORG, role },
      }),
    'GET /practices': (c) => {
      const created = c.query.get('status') === 'CREATED';
      return ok({
        items: created ? [PRACTICE] : [],
        total: created ? 1 : 0,
        page: 1,
        limit: 50,
        totalPages: 1,
      });
    },
    'GET /practices/assignees': () =>
      ok([
        { userId: 'u-1', email: 'anna@coop.it', role: 'OPERATOR' },
        { userId: 'u-3', email: null, role: 'ADMIN' },
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

describe('board of practices (A4)', () => {
  it('asks one column per state, filtered by assignee', () => {
    expect(boardQuery('CREATED', 'all')).toBe(
      '/practices?status=CREATED&limit=50&sortBy=updatedAt&sortOrder=desc',
    );
    expect(boardQuery('SUBMITTED', 'me')).toContain('assignedTo=me');
  });

  it('assigns a practice and moves it after a confirmation', async () => {
    api('OPERATOR', {
      [`POST /practices/${PRACTICE.id}/assign`]: () => ok({ assignedTo: 'u-1' }),
      [`POST /practices/${PRACTICE.id}/transition`]: () => ok({ ...PRACTICE, status: 'VALIDATED' }),
    });
    openAt('/bacheca');
    expect(await screen.findByText('Vendemmia 2026')).toBeTruthy();
    for (const column of ['Creata', 'Validata', 'Inviata', 'Completata', 'Non riuscita']) {
      expect(screen.getByRole('heading', { name: new RegExp(column) })).toBeTruthy();
    }
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Assegna «Vendemmia 2026»' }),
      'u-1',
    );
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/assign'))?.body).toEqual({ userId: 'u-1' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Valida' }));
    expect(calls.some((c) => c.path.endsWith('/transition'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Conferma' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/transition'))?.body).toEqual({
        nextState: 'VALIDATED',
      }),
    );
  });

  it('is not offered to a member', async () => {
    api('MEMBER');
    openAt('/bacheca');
    expect(await screen.findByText(/La bacheca è per amministratori e operatori/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Bacheca' })).toBeNull();
    expect(calls.some((c) => c.path === '/practices')).toBe(false);
  });
});
