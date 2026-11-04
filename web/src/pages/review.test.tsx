/**
 * A1: the page of documents to verify (confirm, correct, change type) and the confirmed data in
 * the practice detail, against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startingValues, toPayload } from '../api/review';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const PRACTICE = 'p0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const ITEM = {
  attachmentId: 'f0000000-0000-4000-8000-000000000001',
  practiceId: PRACTICE,
  practiceName: 'Mario Rossi',
  fileName: 'scontrino.jpg',
  mimeType: 'image/jpeg',
  createdAt: '2026-10-31T10:22:00Z',
  ocrStatus: 'COMPLETED',
  reviewRequired: true,
  missingFields: [],
  warnings: [],
  read: { documentType: 'generic', fields: { title: 'DOCUMENTO COMMERCIALE' } },
  validated: null,
};

let calls: Call[];

function api(routes: Record<string, (c: Call) => Answer>) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'mario@coop.it',
        organizations: [{ orgId: ORG, name: 'Cooperativa', role: 'OPERATOR' }],
        platform: false,
        current: { orgId: ORG, role: 'OPERATOR' },
      }),
    'GET /attachments/review': (c) =>
      ok({
        items: c.query.get('status') === 'validated' ? [] : [ITEM],
        total: 1,
        page: 1,
        totalPages: 1,
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

const VALIDATION = `/practices/${PRACTICE}/attachments/${ITEM.attachmentId}/validation`;

beforeEach(() => vi.unstubAllGlobals());

describe('review helpers', () => {
  it('turns form values into API values: empty is null, amounts with comma or dot', () => {
    expect(
      toPayload('receipt', {
        merchantName: ' Bar ',
        merchantVat: '',
        documentDate: '2026-10-30',
        totalAmount: '1.234,50',
        vatAmount: '0.85',
      }),
    ).toEqual({
      merchantName: 'Bar',
      merchantVat: null,
      documentDate: '2026-10-30',
      totalAmount: 1234.5,
      vatAmount: 0.85,
    });
    expect(startingValues('receipt', { totalAmount: 9.35, title: 'x' })).toEqual({
      merchantName: '',
      merchantVat: '',
      documentDate: '',
      totalAmount: '9.35',
      vatAmount: '',
    });
  });
});

describe('documents to verify (A1)', () => {
  it('corrects the type and the data of a document, then confirms', async () => {
    api({ [`POST ${VALIDATION}`]: () => ok({ outcome: 'corrected' }) });
    openAt('/verifica');
    const card = (await screen.findByText('scontrino.jpg')).closest('li')!;
    expect(within(card).getByText('Documento', { selector: 'strong' })).toBeTruthy();
    await userEvent.selectOptions(within(card).getByLabelText('Tipo di documento'), 'receipt');
    await userEvent.type(within(card).getByLabelText('Esercente'), 'Pasticceria Rossi');
    await userEvent.type(within(card).getByLabelText('Totale'), '9,35');
    await userEvent.click(within(card).getByRole('button', { name: 'Conferma i dati' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === VALIDATION)?.body).toEqual({
        documentType: 'receipt',
        fields: {
          merchantName: 'Pasticceria Rossi',
          merchantVat: null,
          documentDate: null,
          totalAmount: 9.35,
          vatAmount: null,
        },
      }),
    );
    expect((await screen.findByRole('status')).textContent).toContain('corretti e confermati');
  });

  it('explains a refused value in Italian', async () => {
    api({
      [`POST ${VALIDATION}`]: () => ({
        status: 400,
        body: {
          success: false,
          error: { code: 'INVALID_DOCUMENT_DATA', message: 'Data: data non valida (AAAA-MM-GG)' },
        },
      }),
    });
    openAt('/verifica');
    await userEvent.click(await screen.findByRole('button', { name: 'Conferma i dati' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Data: data non valida (AAAA-MM-GG)',
    );
  });

  it('shows the confirmed data in the practice, with the way to correct them', async () => {
    api({
      [`GET /practices/${PRACTICE}`]: () =>
        ok({
          id: PRACTICE,
          userId: 'u-1',
          status: 'CREATED',
          name: 'Mario Rossi',
          kind: 'generic',
          typeLabel: 'generic',
          summary: '',
          createdAt: '2026-10-31T10:00:00Z',
          updatedAt: '2026-10-31T10:00:00Z',
          allowedTransitions: [],
        }),
      [`GET /practices/${PRACTICE}/attachments`]: () =>
        ok([
          {
            id: ITEM.attachmentId,
            practiceId: PRACTICE,
            fileName: 'scontrino.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1000,
            ocrStatus: 'COMPLETED',
            ocrResult: { documentType: 'generic', title: 'DOCUMENTO', reviewRequired: true },
            validatedData: {
              documentType: 'receipt',
              fields: { merchantName: 'Pasticceria Rossi', totalAmount: 9.35 },
            },
            validatedAt: '2026-10-31T11:00:00Z',
            createdAt: '2026-10-31T10:22:00Z',
          },
        ]),
    });
    openAt(`/pratiche/${PRACTICE}`);
    expect(await screen.findByText('Pasticceria Rossi')).toBeTruthy();
    expect(screen.getByText(/Dati confermati: Ricevuta/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Correggi i dati' }));
    expect(screen.getByLabelText<HTMLInputElement>('Esercente').value).toBe('Pasticceria Rossi');
  });
});
