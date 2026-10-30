/**
 * FE1: login with the email code, choice of the organization, profile, session renewal and exit,
 * against a simulated API (the backend side is covered by tests/fe0.dashboard-backend.test.ts).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { SessionProvider } from './session/session';

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
type Handler = (call: Call) => { status: number; body?: unknown };

const orgA = {
  orgId: 'a0000000-0000-4000-8000-000000000001',
  name: 'Cooperativa Alfa',
  role: 'ADMIN',
};
const orgB = {
  orgId: 'b0000000-0000-4000-8000-000000000002',
  name: 'Consorzio Beta',
  role: 'MEMBER',
};

const ok = (data: unknown) => ({ status: 200, body: { success: true, data } });
const fail = (status: number) => ({
  status,
  body: { success: false, error: { code: 'X', message: 'x' } },
});

let calls: Call[];

/** A fake API: each route answers with its handler; unknown routes are 404. */
function api(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const call: Call = {
        method,
        path: input,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const answer = routes[`${method} ${input}`]?.(call) ?? fail(404);
      return Promise.resolve(
        new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
          status: answer.status,
        }),
      );
    }),
  );
}

const me = (current = orgA, organizations = [orgA]) =>
  ok({
    userId: 'u-1',
    email: 'mario@cooperativa.it',
    organizations,
    current: { orgId: current.orgId, role: current.role },
  });

function renderApp() {
  window.history.pushState({}, '', '/app/');
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserRouter basename="/app">
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

async function login(code = '123456') {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), 'mario@cooperativa.it');
  await user.click(screen.getByRole('button', { name: 'Ricevi il codice di accesso' }));
  await user.type(await screen.findByLabelText('Codice'), code);
  await user.click(screen.getByRole('button', { name: 'Accedi' }));
  return user;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard session (FE1)', () => {
  it('logs in with the email code and opens the only organization', async () => {
    api({
      'POST /auth/login/start': () => ok({ challengeId: 'c-1', devCode: '123456' }),
      'POST /auth/login/verify': () => ok({ userId: 'u-1', organizations: [orgA] }),
      'POST /auth/token': () => ok({ accessToken: 'tok-1', expiresIn: 600 }),
      'GET /auth/me': () => me(),
    });
    renderApp();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'mario@cooperativa.it');
    await user.click(screen.getByRole('button', { name: 'Ricevi il codice di accesso' }));
    // Development only: the code shown by the backend.
    expect(await screen.findByText('123456')).toBeTruthy();
    await user.type(screen.getByLabelText('Codice'), '123456');
    await user.click(screen.getByRole('button', { name: 'Accedi' }));

    expect(await screen.findByRole('heading', { name: 'Cooperativa Alfa' })).toBeTruthy();
    // The access token travels in memory and every call is marked as coming from the dashboard.
    const meCall = calls.find((c) => c.path === '/auth/me');
    expect(meCall?.headers.authorization).toBe('Bearer tok-1');
    expect(meCall?.headers['x-sinfonia-client']).toBe('web');
    expect(JSON.stringify(localStorage)).not.toContain('tok-1');
  });

  it('asks which organization to use when there are several', async () => {
    api({
      'POST /auth/login/start': () => ok({ challengeId: 'c-1' }),
      'POST /auth/login/verify': () => ok({ userId: 'u-1', organizations: [orgA, orgB] }),
      'POST /auth/token': () => ok({ accessToken: 'tok-b', expiresIn: 600 }),
      'GET /auth/me': () => me(orgB, [orgA, orgB]),
    });
    renderApp();
    const user = await login();
    await user.click(await screen.findByRole('button', { name: /Consorzio Beta/ }));
    expect(await screen.findByRole('heading', { name: 'Consorzio Beta' })).toBeTruthy();
    expect(calls.find((c) => c.path === '/auth/token')?.body).toEqual({ orgId: orgB.orgId });
  });

  it('says when the code is wrong, without saying why', async () => {
    api({
      'POST /auth/login/start': () => ok({ challengeId: 'c-1' }),
      'POST /auth/login/verify': () => fail(401),
    });
    renderApp();
    await login('000000');
    expect((await screen.findByRole('alert')).textContent).toBe('Codice non valido o scaduto.');
  });

  it('resumes the last organization after a reload, and falls back to the login', async () => {
    localStorage.setItem('sinfonia.lastOrganization', orgA.orgId);
    api({
      'POST /auth/token': () => ok({ accessToken: 'tok-1', expiresIn: 600 }),
      'GET /auth/me': () => me(),
    });
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Cooperativa Alfa' })).toBeTruthy();

    // A revoked session: the renewal fails and the login comes back.
    localStorage.setItem('sinfonia.lastOrganization', orgA.orgId);
    api({ 'POST /auth/token': () => fail(401) });
    renderApp();
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(localStorage.getItem('sinfonia.lastOrganization')).toBeNull();
  });

  it('logs out here, or everywhere after a confirmation', async () => {
    localStorage.setItem('sinfonia.lastOrganization', orgA.orgId);
    api({
      'POST /auth/token': () => ok({ accessToken: 'tok-1', expiresIn: 600 }),
      'GET /auth/me': () => me(),
      'POST /auth/logout-all': () => ({ status: 204 }),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Profilo' }));
    expect(await screen.findByText('mario@cooperativa.it')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Esci da tutti i dispositivi' }));
    await user.click(screen.getByRole('button', { name: 'Sì, esci ovunque' }));
    expect(await screen.findByText('Sei uscito da tutti i dispositivi.')).toBeTruthy();
    const everywhere = calls.find((c) => c.path === '/auth/logout-all');
    expect(everywhere?.headers.authorization).toBe('Bearer tok-1');
    await waitFor(() => expect(localStorage.getItem('sinfonia.lastOrganization')).toBeNull());
  });
});
