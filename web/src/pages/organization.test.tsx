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
  miniAppBackground: null,
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
      const body = c.body as { name?: string; scheduledExport?: object };
      orgName = body.name ?? orgName;
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
    expect(
      describeEvent(
        event({
          type: 'ORGANIZATION_SETTINGS_CHANGED',
          details: { taxCode: 'set', vatNumber: 'removed' },
        }),
      ),
    ).toBe('Impostazioni: codice fiscale / CUAA aggiornato, partita IVA tolta');
    expect(
      describeEvent(
        event({ type: 'COMPANY_IDENTIFIERS_VIEWED', details: { channel: 'telegram' } }),
      ),
    ).toBe('Codice fiscale e partita IVA mostrati per intero (Telegram)');
    expect(
      describeEvent(
        event({ type: 'PRACTICE_HOLDER_CHANGED', practice: { id: 'p', name: 'PAC 2026' } }),
      ),
    ).toBe('Pratica «PAC 2026»: titolare giulia@coop.it');
    expect(
      describeEvent(
        event({
          type: 'PRACTICE_HOLDER_CHANGED',
          target: null,
          practice: { id: 'p', name: 'PAC 2026' },
        }),
      ),
    ).toBe("Pratica «PAC 2026»: tornata a chi l'ha aperta");
    expect(
      describeEvent(event({ type: 'PRACTICE_CREATED', practice: { id: 'p', name: 'PAC 2026' } })),
    ).toBe('Pratica «PAC 2026» creata per giulia@coop.it');
    expect(
      describeEvent(
        event({ type: 'ATTACHMENT_REJECTED', practice: { id: 'p', name: 'PAC 2026' } }),
      ),
    ).toBe('Pratica «PAC 2026»: documento respinto');
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
    expect(within(kpis).getByRole('link', { name: '3 pratiche in corso' })).toBeTruthy();
    expect(within(kpis).getByRole('link', { name: '1 scadenza scaduta' })).toBeTruthy();
    expect(screen.getByText('scaduta da 3 giorni')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'fattura.pdf' }).getAttribute('href')).toBe(
      '/app/pratiche/p1',
    );
    expect(
      await screen.findByText('Ruolo di giulia@coop.it: da collaboratore a operatore'),
    ).toBeTruthy();
    expect(requested('/audit')[0]?.query.get('limit')).toBe('10');
  });

  it('compares the last 30 days with the 30 before and draws the chart by period', async () => {
    // 90 days: one practice a day in the last 30, one a day in 15 of the 30 before.
    const activity = Array.from({ length: 90 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 7, 22) + i * 86_400_000).toISOString().slice(0, 10),
      practices: i >= 60 || (i >= 30 && i < 45) ? 1 : 0,
      documents: 2,
    }));
    api('ADMIN', { 'GET /dashboard/summary': () => ok({ ...SUMMARY, activity }) });
    openAt('/');
    const kpis = await screen.findByRole('list', { name: 'Indicatori' });
    expect(
      within(kpis).getByRole('link', { name: '30 pratiche aperte in 30 giorni' }),
    ).toBeTruthy();
    expect(within(kpis).getByText('+100%')).toBeTruthy();
    expect(screen.getByText(/ultimi 3 mesi: 45 pratiche aperte e 180 documenti/)).toBeTruthy();
    const period = screen.getByRole('group', { name: 'Periodo del grafico' });
    const week = within(period).getByRole('button', { name: /Ultimi 7 giorni/ });
    await userEvent.click(week);
    expect(week.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/ultimi 7 giorni: 7 pratiche aperte e 14 documenti/)).toBeTruthy();
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
        municipality: null,
        sector: null,
        taxCode: null,
        vatNumber: null,
        scheduledExport: { enabled: true, frequency: 'weekly' },
      }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    // The sidebar shows the organization under the name of SinfonIA.
    const sidebar = screen.getByRole('complementary', { name: 'Menu della dashboard' });
    expect(await within(sidebar).findByText('Cooperativa Nuova')).toBeTruthy();
    expect(screen.getByText(/30, 15, 7, 1 giorni prima/)).toBeTruthy();
  });

  it('saves codice fiscale / CUAA and partita IVA, and shows a wrong one refused', async () => {
    let refuse = true;
    api('ADMIN', {
      'PATCH /organization': (c) =>
        refuse
          ? {
              status: 400,
              body: {
                success: false,
                error: {
                  code: 'COMPANY_IDENTIFIERS_INVALID',
                  message: 'Partita IVA non valida: servono 11 cifre corrette.',
                },
              },
            }
          : ok({ ...SETTINGS, ...(c.body as object) }),
    });
    openAt('/impostazioni');
    await userEvent.type(await screen.findByLabelText('Codice fiscale / CUAA'), 'RSSMRA85T10A562S');
    await userEvent.type(screen.getByLabelText('Partita IVA'), '12345678901');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Partita IVA non valida');

    refuse = false;
    await userEvent.clear(screen.getByLabelText('Partita IVA'));
    await userEvent.type(screen.getByLabelText('Partita IVA'), '12345678903');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() =>
      expect(
        requested('/organization')
          .filter((c) => c.method === 'PATCH')
          .at(-1)?.body,
      ).toMatchObject({ taxCode: 'RSSMRA85T10A562S', vatNumber: '12345678903' }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText(/le reti non li vedono/)).toBeTruthy();
  });

  it('saves a dark background for the Mini App and refuses one too light for white text', async () => {
    api('ADMIN', {});
    openAt('/impostazioni');
    const hex = await screen.findByLabelText('Colore');
    const save = screen.getByRole('button', { name: 'Salva il colore' });
    expect((hex as HTMLInputElement).value).toBe('#1f1f1f');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(hex);
    await userEvent.type(hex, '#D9C7A0');
    expect((await screen.findByRole('alert')).textContent).toContain('Troppo chiaro');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(hex);
    await userEvent.type(hex, '#5A3E2B');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(save);
    await waitFor(() =>
      expect(requested('/organization').find((c) => c.method === 'PATCH')?.body).toEqual({
        miniAppBackground: '#5a3e2b',
      }),
    );
    expect((await screen.findByRole('status')).textContent).toContain('Colore salvato');
    // Back to the grey.
    await userEvent.click(screen.getByRole('button', { name: 'Torna al grigio predefinito' }));
    await waitFor(() =>
      expect(
        requested('/organization')
          .filter((c) => c.method === 'PATCH')
          .at(-1)?.body,
      ).toEqual({ miniAppBackground: null }),
    );
    // The logo of the organization, from its own settings.
    expect(screen.getByRole('button', { name: 'Carica il logo' })).toBeTruthy();
    await waitFor(() => expect(requested('/organization/logo').length).toBeGreaterThan(0));
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
