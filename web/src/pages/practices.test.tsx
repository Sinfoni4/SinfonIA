/**
 * FE2: practices list with filters and pages, new practice, allowed state changes with
 * confirmation, attachments upload, download and data read, against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
// raw: a file body as text (a jsdom Blob is not accepted by the Response of every Node version).
type Answer = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ME = 'u0000000-0000-4000-8000-000000000001';
const OTHER = 'u0000000-0000-4000-8000-000000000002';
const P1 = 'p0000000-0000-4000-8000-000000000001';

const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const practice = (over: Record<string, unknown> = {}) => ({
  id: P1,
  userId: ME,
  status: 'CREATED',
  name: 'Mario Rossi',
  kind: 'generic',
  typeLabel: 'Generica',
  summary: '',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...over,
});

let calls: Call[];

function api(role: 'ADMIN' | 'MEMBER', routes: Record<string, (c: Call) => Answer>) {
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
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const call: Call = {
        method: init.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body:
          init.body instanceof FormData
            ? Object.fromEntries(
                [...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]),
              )
            : typeof init.body === 'string'
              ? (JSON.parse(init.body) as unknown)
              : undefined,
      };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const answer = (routes[key] ?? base[key])?.(call) ?? {
        status: 404,
        body: { success: false, error: { code: 'NOT_FOUND', message: 'x' } },
      };
      return Promise.resolve(
        new Response(answer.raw ?? JSON.stringify(answer.body), {
          status: answer.status,
          headers: answer.headers,
        }),
      );
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

describe('practices (FE2)', () => {
  it('lists practices with search, status, «solo le mie» and pages', async () => {
    api('ADMIN', {
      'GET /practices': (c) =>
        ok({
          items: [
            practice(),
            practice({ id: 'p2', name: 'Anna Bianchi', userId: OTHER, status: 'COMPLETED' }),
          ],
          total: 25,
          page: Number(c.query.get('page')),
          limit: 20,
          totalPages: 2,
        }),
    });
    openAt('/pratiche');
    const user = userEvent.setup();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Mario Rossi' })).toBeTruthy();
    expect(within(table).getByText('Completata')).toBeTruthy();
    expect(within(table).getAllByText('mia')).toHaveLength(1);

    await user.type(screen.getByRole('searchbox'), 'Rossi');
    await user.selectOptions(screen.getByLabelText('Stato'), 'CREATED');
    await user.click(screen.getByLabelText('Solo le mie'));
    await user.click(screen.getByRole('button', { name: 'Cerca' }));
    await user.click(screen.getByRole('button', { name: 'Successiva' }));
    await waitFor(() => {
      const last = calls.filter((c) => c.path === '/practices').at(-1)!;
      expect(Object.fromEntries(last.query)).toMatchObject({
        search: 'Rossi',
        status: 'CREATED',
        userId: ME,
        page: '2',
      });
    });
  });

  it('does not offer «solo le mie» to a MEMBER, who sees only their own anyway', async () => {
    api('MEMBER', {
      'GET /practices': () =>
        ok({ items: [practice()], total: 1, page: 1, limit: 20, totalPages: 1 }),
    });
    openAt('/pratiche');
    await screen.findByRole('table');
    expect(screen.queryByLabelText('Solo le mie')).toBeNull();
  });

  it('creates a practice and opens it', async () => {
    api('ADMIN', {
      'POST /practices': () => ({ status: 201, body: { success: true, data: practice() } }),
      'GET /practices/:id': () => ok({}),
      [`GET /practices/${P1}`]: () => ok({ ...practice(), allowedTransitions: [] }),
      [`GET /practices/${P1}/attachments`]: () => ok([]),
    });
    openAt('/pratiche/nuova');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Nome'), 'Mario Rossi');
    await user.click(screen.getByRole('button', { name: 'Crea pratica' }));
    expect(await screen.findByRole('heading', { name: 'Mario Rossi' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/practices')?.body).toEqual({
      name: 'Mario Rossi',
      kind: 'generic',
    });
  });

  it('offers only the allowed state changes, and asks before applying one', async () => {
    let status = 'CREATED';
    api('ADMIN', {
      [`GET /practices/${P1}`]: () =>
        ok({
          ...practice({ status }),
          allowedTransitions: status === 'CREATED' ? ['VALIDATED', 'SUBMITTED'] : [],
        }),
      [`GET /practices/${P1}/attachments`]: () => ok([]),
      [`POST /practices/${P1}/transition`]: (c) => {
        status = (c.body as { nextState: string }).nextState;
        return ok(practice({ status }));
      },
    });
    openAt(`/pratiche/${P1}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Valida' }));
    expect(screen.getByText('Confermi «Valida» per questa pratica?')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/transition'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Conferma' }));
    expect(await screen.findByText('Validata')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Valida' })).toBeNull();
  });

  it('shows the data read from an attachment and downloads it as a file', async () => {
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    api('ADMIN', {
      [`GET /practices/${P1}`]: () =>
        ok({ ...practice({ userId: OTHER }), allowedTransitions: [] }),
      [`GET /practices/${P1}/attachments`]: () =>
        ok([
          {
            id: 'att-1',
            practiceId: P1,
            fileName: 'fattura.pdf',
            mimeType: 'application/pdf',
            fileSize: 20480,
            ocrStatus: 'COMPLETED',
            ocrResult: {
              documentType: 'invoice',
              supplierName: 'Ferramenta Srl',
              totalAmount: 122,
              currency: 'EUR',
              reviewRequired: true,
              warnings: ['Data non leggibile'],
            },
            createdAt: '2026-10-29T10:00:00.000Z',
          },
        ]),
      [`GET /practices/${P1}/attachments/att-1/download`]: () => ({
        status: 200,
        raw: '%PDF-1.4 test',
        headers: { 'content-disposition': 'attachment; filename="fattura.pdf"' },
      }),
    });
    openAt(`/pratiche/${P1}`);
    const user = userEvent.setup();
    expect(await screen.findByText('fattura.pdf')).toBeTruthy();
    expect(screen.getByText(/Dati letti: Fattura/)).toBeTruthy();
    expect(screen.getByText('Ferramenta Srl')).toBeTruthy();
    expect(screen.getByText('da verificare')).toBeTruthy();
    // Someone else's practice: no upload form (attachments go only to one's own practices).
    expect(screen.queryByRole('button', { name: 'Carica' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Scarica' }));
    await waitFor(() => expect(created).toHaveBeenCalled());
  });

  it('uploads a document with its hint on an own practice', async () => {
    let uploaded = false;
    api('MEMBER', {
      [`GET /practices/${P1}`]: () => ok({ ...practice(), allowedTransitions: [] }),
      [`GET /practices/${P1}/attachments`]: () => ok([]),
      [`POST /practices/${P1}/attachments`]: () => {
        uploaded = true;
        return { status: 201, body: { success: true, data: {} } };
      },
    });
    openAt(`/pratiche/${P1}`);
    const user = userEvent.setup();
    const file = new File(['%PDF'], 'ricevuta.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText('File (PDF o immagine)'), file);
    await user.type(screen.getByLabelText('Che documento è? (facoltativo)'), 'ricevuta');
    await user.click(screen.getByRole('button', { name: 'Carica' }));
    expect(await screen.findByText('Documento caricato.')).toBeTruthy();
    expect(uploaded).toBe(true);
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/attachments'));
    expect(post?.body).toEqual({ hint: 'ricevuta', file: 'ricevuta.pdf' });
  });
});
