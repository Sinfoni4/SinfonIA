import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink } from 'react-router';

import { describeError, type Me } from '../api/client';
import {
  actorLabel,
  auditQuery,
  describeEvent,
  EVENT_GROUPS,
  formatDateTime,
  isProblem,
  OUTCOME_LABELS,
  type AuditPage,
  type Trace,
  type TraceOutcome,
} from '../api/organization';
import { useSession } from '../session/session';

const OUTCOMES = Object.keys(OUTCOME_LABELS) as TraceOutcome[];
const TRACE_PAGE = 50;

/** Shared header of the two views: the activity log (P13) and the assistant usage (P14). */
function Tabs() {
  return (
    <nav className="tabs" aria-label="Viste dell'attività">
      <NavLink to="/attivita" end>
        Registro
      </NavLink>
      <NavLink to="/attivita/assistente">Assistente</NavLink>
    </nav>
  );
}

function AdminsOnly() {
  return (
    <>
      <h1>Attività</h1>
      <p className="muted">Solo gli amministratori vedono il registro delle attività.</p>
    </>
  );
}

/** P13: who did what in the organization; events and people, never document contents. */
export function ActivityPage({ me }: { me: Me }) {
  const { api } = useSession();
  const isAdmin = me.current.role === 'ADMIN';
  const [filters, setFilters] = useState({ page: 1, group: '', from: '', to: '' });

  const query = useQuery({
    queryKey: ['audit', me.current.orgId, filters],
    queryFn: () => api<AuditPage>(auditQuery(filters)),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
  });

  if (!isAdmin) return <AdminsOnly />;
  const data = query.data;

  return (
    <>
      <h1>Attività</h1>
      <Tabs />
      <div className="filters">
        <label>
          Tipo
          <select
            value={filters.group}
            onChange={(e) => setFilters((f) => ({ ...f, page: 1, group: e.target.value }))}
          >
            <option value="">Tutte</option>
            {Object.entries(EVENT_GROUPS).map(([key, g]) => (
              <option key={key} value={key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dal
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, page: 1, from: e.target.value }))}
          />
        </label>
        <label>
          Al
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, page: 1, to: e.target.value }))}
          />
        </label>
      </div>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {data && data.items.length === 0 && <p className="muted">Nessuna attività.</p>}
      {data && data.items.length > 0 && (
        <>
          <table className="list cards">
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Chi</th>
                <th scope="col">Che cosa</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td data-label="Quando">{formatDateTime(e.at)}</td>
                  <td data-label="Chi">{actorLabel(e)}</td>
                  <td data-label="Che cosa">{describeEvent(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            onPage={(page) => setFilters((f) => ({ ...f, page }))}
          />
        </>
      )}
      <p className="muted">
        Il registro mostra eventi e persone, mai il contenuto dei documenti. Per quanto tempo viene
        conservato dipende dalla verifica legale in corso.
      </p>
    </>
  );
}

function Pager(props: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (props.totalPages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pagine">
      <button
        type="button"
        className="secondary"
        disabled={props.page <= 1}
        onClick={() => props.onPage(props.page - 1)}
      >
        Precedenti
      </button>
      <span>
        Pagina {props.page} di {props.totalPages} ({props.total} eventi)
      </span>
      <button
        type="button"
        className="secondary"
        disabled={props.page >= props.totalPages}
        onClick={() => props.onPage(props.page + 1)}
      >
        Successivi
      </button>
    </nav>
  );
}

/** P14: the latest requests to the assistant, by outcome; never the text of the requests. */
export function AssistantUsagePage({ me }: { me: Me }) {
  const { api } = useSession();
  const isAdmin = me.current.role === 'ADMIN';
  const [outcome, setOutcome] = useState<TraceOutcome | ''>('');

  const query = useQuery({
    queryKey: ['traces', me.current.orgId, outcome],
    queryFn: () =>
      api<Trace[]>(
        `/ai/traces?limit=${TRACE_PAGE}${outcome ? `&outcome=${encodeURIComponent(outcome)}` : ''}`,
      ),
    enabled: isAdmin,
  });

  if (!isAdmin) return <AdminsOnly />;
  const traces = query.data ?? [];
  const problems = traces.filter((t) => isProblem(t.outcome)).length;
  const tokens = traces.reduce((sum, t) => sum + (t.tokens?.totalTokens ?? 0), 0);

  return (
    <>
      <h1>Attività</h1>
      <Tabs />
      <div className="filters">
        <label>
          Esito
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as TraceOutcome | '')}>
            <option value="">Tutti</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {query.data && traces.length === 0 && (
        <p className="muted">Nessuna richiesta all&apos;assistente.</p>
      )}
      {traces.length > 0 && (
        <>
          <p>
            Ultime {traces.length} richieste: {problems} con errori o bloccate, {tokens} token in
            totale.
          </p>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Esito</th>
                <th scope="col">Modello</th>
                <th scope="col">Durata</th>
                <th scope="col">Token</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t, i) => (
                <tr key={`${t.requestId}-${i}`}>
                  <td>{formatDateTime(t.timestamp)}</td>
                  <td>
                    <span className={`state ${isProblem(t.outcome) ? 'state-failed' : ''}`}>
                      {OUTCOME_LABELS[t.outcome] ?? t.outcome}
                    </span>
                  </td>
                  <td>
                    {t.provider} · {t.model}
                  </td>
                  <td>{(t.latencyMs / 1000).toLocaleString('it-IT')} s</td>
                  <td>{t.tokens?.totalTokens ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted">
        Per ogni richiesta si registrano solo esito, modello, durata e token: mai il testo scritto
        in chat.
      </p>
    </>
  );
}
