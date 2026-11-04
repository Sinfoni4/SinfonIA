/**
 * H10: the page of requests sent from the chat with «parla con un operatore», against a
 * simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contactLines, type AssistanceItem } from '../api/assistance';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const ITEM: AssistanceItem = {
  id: 'r0000000-0000-4000-8000-000000000001',
  topic: 'DOCUMENT',
  channel: 'TELEGRAM',
  status: 'OPEN',
  createdAt: '2026-11-04T10:22:00Z',
  takenAt: null,
  closedAt: null,
  requester: {
    userId: 'u-2',
    email: null,
    phones: [],
    channels: ['TELEGRAM'],
    practices: 2,
  },
  takenByEmail: null,
  closedByEmail: null,
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
    'GET /assistance': (c) =>
      ok({
        items: c.query.get('status') === 'closed' ? [] : [ITEM],
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

describe('assistance requests (H10)', () => {
  it('says how to reach the person, or that only the chat is known', () => {
    expect(contactLines(ITEM)).toEqual(['Solo dalla chat Telegram: nessun recapito registrato']);
    expect(
      contactLines({
        ...ITEM,
        requester: { ...ITEM.requester, email: 'mario@coop.it', phones: ['393331112222'] },
      }),
    ).toEqual(['Email: mario@coop.it', 'WhatsApp: 393331112222']);
  });

  it('lists the open requests and takes one in charge', async () => {
    api('OPERATOR', {
      [`POST /assistance/${ITEM.id}/take`]: () => ok({ status: 'IN_PROGRESS' }),
    });
    openAt('/assistenza');
    expect(await screen.findByText('Un documento')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Assistenza' })).toBeTruthy();
    expect(screen.getByText('da prendere in carico')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Prendi in carico' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'la persona riceve un avviso',
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/take'))).toBe(true),
    );
  });

  it('is not offered to a member, who is told to write «operatore» in the chat', async () => {
    api('MEMBER');
    openAt('/assistenza');
    expect(await screen.findByText(/scrivi «operatore» nella chat/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Assistenza' })).toBeNull();
    expect(calls.some((c) => c.path === '/assistance')).toBe(false);
  });
});
