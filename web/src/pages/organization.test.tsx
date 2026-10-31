/**
 * FE6: home numbers, settings, activity log and assistant usage, against a simulated API.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auditQuery, describeEvent, type AuditEvent } from '../api/organization';
import { App } from '../App';
import { SessionProvider } from '../session/session';

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = { status: number; body?: unknown };

const ORG = 'a0000000-0000-4000-8000-000000000001';
const ok = (data: unknown): Answer => ({ status: 200, body: { success: true, data } });

const SUMMARY = {
  practices: {
    total: 6,
    byStatus: { CREATED: 2, VALIDATED: 1, SUBMITTED: 0, FAILED: 1, COMPLETED: 2 },
  },
  deadlines: {
    overdue: 1,
    dueSoon: 2,
    upcoming: [
      {
        id: 'd1',
        title: 'DURC cooperativa',
        category: 'DURC',
        dueDate: '2026-10-28',
        daysLeft: -3,
      },
    ],
  },
  documents: {
    toReview: 1,
    unreadable: 0,
    items: [
      {
        attachmentId: 'a1',
        practiceId: 'p1',
        practiceName: 'Fattura ottobre',
        fileName: 'fattura.pdf',
        reason: 'review',
      },
    ],
  },
  recentPractices: [
    { id: 'p1', name: 'Fattura ottobre', status: 'CREATED', updatedAt: '2026-10-30T10:00:00Z' },
  ],
};

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 'e1',
  at: '2026-10-30T14:05:00.000Z',
  type: 'MEMBER_ROLE_CHANGED',
  actor: { userId: 'u-1', email: 'mario@coop.it' },
  target: { userId: 'u-2', email: 'giulia@coop.it' },
  practice: null,
  period: null,
  details: { from: 'MEMBER', to: 'OPERATOR' },
  ...over,
});

const SETTINGS = {
  id: ORG,
  name: 'Cooperativa',
  type: 'COMPANY',
  scheduledExport: { enabled: false, frequency: 'monthly' },
  reminderDays: [30, 15, 7, 1],
};

let calls: Call[];

function api(role: 'ADMIN' | 'OPERATOR' | 'MEMBER', routes: Record<string, (c: Call) => Answer>) {
  calls = [];
  let orgName = 'Cooperativa';
  const base: Record<string, (c: Call) => Answer> = {
    'POST /auth/token': () => ok({ accessToken: 'tok', expiresIn: 600 }),
    'GET /auth/me': () =>
      ok({
        userId: 'u-1',
        email: 'mario@coop.it',
        organizations: [{ orgId: ORG, name: orgName, role }],
        current: { orgId: ORG, role },
      }),
    'GET /dashboard/summary': () => ok(SUMMARY),
    'GET /audit': () => ok({ items: [event()], total: 1, page: 1, limit: 50, totalPages: 1 }),
    'GET /organization': () => ok(SETTINGS),
    'PATCH /organization': (c) => {
      const body = c.body as { name: string; scheduledExport: object };
      orgName = body.name;
      return ok({ ...SETTINGS, ...body });
    },
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

const requested = (path: string) => calls.filter((c) => c.path === path);

beforeEach(() => vi.unstubAllGlobals());

describe('activity helpers', () => {
  it('describes events in Italian, with people by email', () => {
    expect(describeEvent(event())).toBe('Ruolo di giulia@coop.it: da collaboratore a operatore');
    expect(
      describeEvent(
        event({
          type: 'PRACTICE_STATE_CHANGED',
          practice: { id: 'p', name: null },
          details: { from: 'CREATED', to: 'VALIDATED' },
        }),
      ),
    ).toBe('Pratica «pratica eliminata»: da creata a validata');
    expect(
      describeEvent(
        event({ type: 'EXPORT_GENERATED', period: 'month', details: { channel: 'web', rows: 1 } }),
      ),
    ).toBe('Export pratiche del mese (dashboard), 1 riga');
    expect(
      describeEvent(
        event({
          type: 'ORGANIZATION_SETTINGS_CHANGED',
          details: { scheduledExport: true, frequency: 'weekly' },
        }),
      ),
    ).toBe('Impostazioni: export pianificato attivato, frequenza ogni settimana');
  });

  it('builds the log query from a group of events and whole days', () => {
    const q = new URL(
      auditQuery({ page: 2, group: 'settings', from: '2026-10-01', to: '2026-10-31' }),
      'http://x',
    ).searchParams;
    expect(q.get('page')).toBe('2');
    expect(q.get('types')?.split(',')).toContain('ORGANIZATION_SETTINGS_CHANGED');
    expect(q.get('from')).toBe('2026-10-01T00:00:00');
    expect(q.get('to')).toBe('2026-10-31T23:59:59.999');
  });
});

describe('home (P11)', () => {
  it('shows the numbers, the lists and, for administrators, the latest activity', async () => {
    api('ADMIN', {});
    openAt('/');
    const kpis = await screen.findByRole('list', { name: 'Indicatori' });
    expect(within(kpis).getByText(/pratiche in corso/).textContent).toContain('3');
    expect(within(kpis).getByText(/scadenza scaduta/).textContent).toContain('1');
    expect(screen.getByText('scaduta da 3 giorni')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'fattura.pdf' }).getAttribute('href')).toBe(
      '/app/pratiche/p1',
    );
    expect(
      await screen.findByText('Ruolo di giulia@coop.it: da collaboratore a operatore'),
    ).toBeTruthy();
    expect(requested('/audit')[0]?.query.get('limit')).toBe('10');
  });

  it('does not ask a member for the activity log', async () => {
    api('MEMBER', {});
    openAt('/');
    expect(await screen.findByText(/qui vedi le tue pratiche/)).toBeTruthy();
    await screen.findByRole('list', { name: 'Indicatori' });
    expect(screen.queryByRole('heading', { name: 'Ultime attività' })).toBeNull();
    expect(requested('/audit')).toHaveLength(0);
  });
});

describe('settings (P12)', () => {
  it('saves name and scheduled export, then shows the new name in the header', async () => {
    api('ADMIN', {});
    openAt('/impostazioni');
    const name = await screen.findByLabelText('Nome');
    const save = screen.getByRole('button', { name: 'Salva' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Frequenza').disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, 'Cooperativa Nuova');
    await userEvent.click(screen.getByLabelText('Attivo'));
    await userEvent.selectOptions(screen.getByLabelText('Frequenza'), 'weekly');
    await userEvent.click(save);
    await waitFor(() =>
      expect(requested('/organization').find((c) => c.method === 'PATCH')?.body).toEqual({
        name: 'Cooperativa Nuova',
        scheduledExport: { enabled: true, frequency: 'weekly' },
      }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(await screen.findByText('Cooperativa Nuova', { selector: '.org span' })).toBeTruthy();
    expect(screen.getByText(/30, 15, 7, 1 giorni prima/)).toBeTruthy();
  });

  it('is only for administrators, also in the menu', async () => {
    api('OPERATOR', {});
    openAt('/impostazioni');
    expect(await screen.findByText(/Solo gli amministratori modificano/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Impostazioni' })).toBeNull();
    expect(requested('/organization')).toHaveLength(0);
  });
});

describe('activity (P13, P14)', () => {
  it('lists events and filters them by type and dates', async () => {
    api('ADMIN', {});
    openAt('/attivita');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('mario@coop.it')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Tipo'), 'people');
    await waitFor(() =>
      expect(requested('/audit').at(-1)?.query.get('types')).toContain('MEMBER_ROLE_CHANGED'),
    );
    await userEvent.type(screen.getByLabelText('Dal'), '2026-10-01');
    await waitFor(() =>
      expect(requested('/audit').at(-1)?.query.get('from')).toBe('2026-10-01T00:00:00'),
    );
  });

  it('shows the assistant usage without any text of the requests', async () => {
    api('ADMIN', {
      'GET /ai/traces': () =>
        ok([
          {
            requestId: 'r1',
            model: 'mistral-small',
            provider: 'mistral',
            latencyMs: 1200,
            outcome: 'SUCCESS',
            tokens: { totalTokens: 300 },
            timestamp: '2026-10-30T10:00:00Z',
          },
          {
            requestId: 'r2',
            model: 'mistral-small',
            provider: 'mistral',
            latencyMs: 800,
            outcome: 'ERROR',
            timestamp: '2026-10-30T09:00:00Z',
          },
        ]),
    });
    openAt('/attivita/assistente');
    expect(
      await screen.findByText('Ultime 2 richieste: 1 con errori o bloccate, 300 token in totale.'),
    ).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('errore')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Esito'), 'ERROR');
    await waitFor(() => expect(requested('/ai/traces').at(-1)?.query.get('outcome')).toBe('ERROR'));
  });
});
