/**
 * Telegram Mini App against a simulated API: opened from Telegram (signed data in the address),
 * the «Oggi» summary, the «Agenda» and an action of the «+» sheet.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { describeFeed, weekOf } from '../api/miniapp';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const PRACTICE = 'p0000000-0000-4000-8000-000000000002';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });
const today = new Date();
const inDays = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const SUMMARY = {
  documents: { confirmed: 3, expected: 4, percent: 75 },
  practices: [
    {
      id: PRACTICE,
      name: 'Bando PSR',
      status: 'CREATED',
      documents: { confirmed: 3, expected: 4 },
      openRequests: 1,
    },
  ],
  requests: [
    {
      id: 'r1',
      practiceId: PRACTICE,
      practiceName: 'Bando PSR',
      label: 'Certificato biologico',
      message: 'Serve il certificato BIO',
      dueDate: '2026-11-15',
    },
  ],
  toConfirm: [],
  deadlines: [
    { id: 'd1', title: 'DURC', category: 'DURC', dueDate: inDays(3), daysLeft: 3 },
    {
      id: 'd2',
      title: 'Visita medica',
      category: 'VISITA_MEDICA',
      dueDate: inDays(20),
      daysLeft: 20,
    },
  ],
  feed: [
    {
      type: 'DOCUMENT_REQUESTED',
      practiceId: PRACTICE,
      practiceName: 'Bando PSR',
      at: new Date().toISOString(),
      expectedLabel: 'Certificato biologico',
    },
  ],
};

let calls: Call[];

function api(routes: Record<string, (c: Call) => Answer> = {}) {
  calls = [];
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/telegram-webapp': () =>
      ok({
        userId: 'u-1',
        organizations: [
          { orgId: ORG, name: 'Azienda Agricola Collio', role: 'MEMBER', type: 'COMPANY' },
        ],
      }),
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'anna@collio.it',
        organizations: [
          { orgId: ORG, name: 'Azienda Agricola Collio', role: 'MEMBER', type: 'COMPANY' },
        ],
        platform: false,
        current: { orgId: ORG, role: 'MEMBER' },
      }),
    'GET /miniapp/summary': () => ok(SUMMARY),
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
      const answer = (routes[key] ?? base[key])?.(call) ?? {
        status: 404,
        body: { success: false, error: { code: 'NOT_FOUND', message: 'x' } },
      };
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    }),
  );
}

function openFromTelegram(path = '/tg') {
  localStorage.clear();
  window.history.pushState(
    {},
    '',
    `/app${path}#tgWebAppData=${encodeURIComponent('user=%7B%22id%22%3A42%7D&hash=abc')}`,
  );
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

describe('Mini App helpers', () => {
  it('builds the week from Monday, marking today and the days with a deadline', () => {
    const week = weekOf(new Date(2026, 10, 7), [
      { id: 'd', title: 'DURC', category: 'DURC', dueDate: '2026-11-04', daysLeft: -3 },
    ]);
    expect(week.map((d) => d.day)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(week.find((d) => d.today)?.day).toBe(7);
    expect(week.filter((d) => d.hasDeadline).map((d) => d.day)).toEqual([4]);
  });

  it('describes events without names or data', () => {
    expect(
      describeFeed({
        type: 'DOCUMENT_REQUESTED',
        practiceId: 'p',
        practiceName: 'Bando PSR',
        at: '',
        expectedLabel: 'Certificato biologico',
      }),
    ).toEqual({ title: 'Richiesto «Certificato biologico»', text: 'per Bando PSR' });
  });
});

describe('Telegram Mini App', () => {
  it('logs in from Telegram and shows the day', async () => {
    api();
    openFromTelegram();
    expect(await screen.findByText('Azienda Agricola Collio')).toBeTruthy();
    // The signed data was sent once and removed from the address.
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/telegram-webapp')?.body).toEqual({
        initData: 'user=%7B%22id%22%3A42%7D&hash=abc',
      }),
    );
    expect(window.location.hash).toBe('');
    const text = (await screen.findByText(/in corso\./)).textContent ?? '';
    expect(text).toContain('1 scadenza');
    expect(text).toContain('1 documento');
    expect(text).toContain('1 pratica');
    expect(screen.getByRole('img', { name: 'Documenti confermati: 75%' })).toBeTruthy();
    expect(screen.getByText('Richiesto «Certificato biologico»')).toBeTruthy();
  });

  it('shows the agenda and asks an operator from the + sheet', async () => {
    api({
      'POST /assistance/requests': () => ({
        status: 201,
        body: { success: true, data: { created: true } },
      }),
    });
    openFromTelegram();
    await userEvent.click(await screen.findByRole('link', { name: 'Agenda' }));
    expect(await screen.findByText('Questa settimana')).toBeTruthy();
    expect(screen.getByText('Manda: Certificato biologico')).toBeTruthy();
    expect(screen.getByText('Visita medica')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Nuova azione' }));
    await userEvent.click(screen.getByRole('button', { name: /Parla con un operatore/ }));
    await userEvent.click(screen.getByRole('button', { name: /Chiedi di essere ricontattato/ }));
    expect(await screen.findByText(/un operatore ti ricontatterà/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/assistance/requests')).toBe(true);
  });

  it('explains how to link when the Telegram account is not linked', async () => {
    api({
      'POST /auth/telegram-webapp': () => ({
        status: 401,
        body: { success: false, error: { code: 'LOGIN_FAILED', message: 'x' } },
      }),
    });
    openFromTelegram();
    expect(await screen.findByText(/scrivi \/accedi al bot/)).toBeTruthy();
  });
});
