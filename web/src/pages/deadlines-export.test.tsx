/**
 * FE3: compliance deadlines (list, filters, new, close with confirmation; read-only for a MEMBER)
 * and the CSV export of practices, against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { daysLabel, exportFileName } from '../api/compliance';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const deadline = (over: Record<string, unknown> = {}) => ({
  id: 'd0000000-0000-4000-8000-000000000001',
  shortId: 'd0000000',
  category: 'DURC',
  title: 'DURC cooperativa',
  dueDate: '2026-11-12',
  daysLeft: 13,
  status: 'OPEN',
  userId: null,
  notes: null,
  closedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

let calls: Call[];

function api(role: 'ADMIN' | 'OPERATOR' | 'MEMBER', routes: Record<string, (c: Call) => Answer>) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'mario@coop.it',
        organizations: [{ orgId: ORG, name: 'Cooperativa', role }],
        current: { orgId: ORG, role },
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

describe('deadline and export helpers', () => {
  it('says how far a deadline is, in Italian', () => {
    expect(daysLabel(0)).toBe('oggi');
    expect(daysLabel(1)).toBe('domani');
    expect(daysLabel(13)).toBe('tra 13 giorni');
    expect(daysLabel(-1)).toBe('scaduta da 1 giorno');
    expect(daysLabel(-4)).toBe('scaduta da 4 giorni');
  });

  it('gives the CSV a safe file name', () => {
    expect(exportFileName('Export pratiche — ottobre 2026')).toBe(
      'export-pratiche-ottobre-2026.csv',
    );
    expect(exportFileName('')).toBe('export-pratiche.csv');
  });
});

describe('deadlines (FE3)', () => {
  it('lists open deadlines and filters by category', async () => {
    api('OPERATOR', {
      'GET /compliance/deadlines': () =>
        ok([
          deadline(),
          deadline({ id: 'd2', title: 'Visita Rossi', category: 'VISITA_MEDICA', daysLeft: -3 }),
        ]),
    });
    openAt('/scadenze');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('DURC cooperativa')).toBeTruthy();
    expect(within(table).getAllByText('12/11/2026')).toHaveLength(2);
    expect(within(table).getByText('tra 13 giorni')).toBeTruthy();
    expect(within(table).getByText('scaduta da 3 giorni')).toBeTruthy();
    expect(calls.find((c) => c.path === '/compliance/deadlines')?.query.get('status')).toBe('OPEN');

    const user = userEvent.setup();
    await user.selectOptions(
      // The filter comes before the form of a new deadline.
      screen.getAllByLabelText('Categoria', { selector: 'select' })[0],
      'DURC',
    );
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.path === '/compliance/deadlines')
          .at(-1)
          ?.query.get('category'),
      ).toBe('DURC'),
    );
  });

  it('adds a deadline and closes one after a confirmation', async () => {
    let open = true;
    api('ADMIN', {
      'GET /compliance/deadlines': () => ok(open ? [deadline()] : []),
      'POST /compliance/deadlines': () => ({
        status: 201,
        body: { success: true, data: deadline() },
      }),
      [`POST /compliance/deadlines/${deadline().id}/close`]: () => {
        open = false;
        return ok(deadline({ status: 'CLOSED' }));
      },
    });
    openAt('/scadenze');
    const user = userEvent.setup();
    const form = (await screen.findByRole('heading', { name: 'Nuova scadenza' })).closest('form')!;
    await user.selectOptions(within(form).getByLabelText('Categoria'), 'PATENTINO');
    await user.type(within(form).getByLabelText('Titolo'), 'Patentino muletto');
    await user.type(within(form).getByLabelText('Data di scadenza'), '2027-03-31');
    await user.click(within(form).getByRole('button', { name: 'Aggiungi scadenza' }));
    expect(await screen.findByText('Scadenza aggiunta: riceverai i promemoria.')).toBeTruthy();
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/compliance/deadlines')?.body,
    ).toEqual({
      category: 'PATENTINO',
      title: 'Patentino muletto',
      dueDate: '2027-03-31',
    });

    await user.click(screen.getByRole('button', { name: 'Chiudi' }));
    expect(calls.some((c) => c.path.endsWith('/close'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Conferma chiusura' }));
    expect(await screen.findByText('Nessuna scadenza.')).toBeTruthy();
  });

  it('shows a MEMBER their deadlines without adding or closing', async () => {
    api('MEMBER', { 'GET /compliance/deadlines': () => ok([deadline()]) });
    openAt('/scadenze');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Chiudi' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nuova scadenza' })).toBeNull();
  });
});

describe('export (FE3)', () => {
  it('exports the chosen year as a CSV file', async () => {
    const created = vi.fn(() => 'blob:csv');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    api('ADMIN', {
      'POST /practices/export': () =>
        ok({
          title: 'Export pratiche 2025',
          csv: 'Nome,Data Creazione\nMario,2025-01-02\n',
          count: 1,
        }),
    });
    openAt('/export');
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Anno', { selector: 'input[type=radio]' }));
    const year = screen.getByLabelText('Anno', { selector: 'input[type=number]' });
    await user.clear(year);
    await user.type(year, '2025');
    await user.click(screen.getByRole('button', { name: 'Scarica CSV' }));
    expect(await screen.findByText('Export pratiche 2025: 1 pratica esportata.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/practices/export')?.body).toEqual({
      filter: { type: 'year', value: 2025 },
    });
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('says when there is nothing to export, without a file', async () => {
    const created = vi.fn(() => 'blob:csv');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    api('MEMBER', {
      'POST /practices/export': () => ok({ title: 'Export pratiche mese', csv: '', count: 0 }),
    });
    openAt('/export');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Scarica CSV' }));
    expect(await screen.findByText('Nessuna pratica nel periodo scelto.')).toBeTruthy();
    expect(created).not.toHaveBeenCalled();
  });
});
