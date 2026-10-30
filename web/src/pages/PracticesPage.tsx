import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { describeError, type Me } from '../api/client';
import {
  formatDate,
  practicesQuery,
  STATE_LABELS,
  type PracticeFilters,
  type PracticePage,
  type PracticeState,
} from '../api/practices';
import { useSession } from '../session/session';

/** P3: practices, paginated, with search and status filter; the perimeter is the backend's. */
export function PracticesPage({ me }: { me: Me }) {
  const { api } = useSession();
  // ADMIN and OPERATOR see the organization; a MEMBER sees only their own anyway.
  const seesOrganization = me.current.role !== 'MEMBER';
  const [filters, setFilters] = useState<PracticeFilters>({
    page: 1,
    search: '',
    status: '',
    mine: false,
  });
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['practices', me.current.orgId, filters],
    queryFn: () => api<PracticePage>(practicesQuery(filters, me.userId)),
    placeholderData: keepPreviousData,
  });

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setFilters((f) => ({ ...f, search, page: 1 }));
  };

  const data = query.data;
  return (
    <>
      <div className="page-head">
        <h1>Pratiche</h1>
        <Link to="/pratiche/nuova" className="button">
          Nuova pratica
        </Link>
      </div>

      <form className="filters" onSubmit={applySearch} role="search">
        <label>
          Cerca
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nome della pratica"
          />
        </label>
        <label>
          Stato
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: e.target.value as PracticeState | '', page: 1 }))
            }
          >
            <option value="">Tutti</option>
            {(Object.keys(STATE_LABELS) as PracticeState[]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {seesOrganization && (
          <label className="check">
            <input
              type="checkbox"
              checked={filters.mine}
              onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked, page: 1 }))}
            />
            Solo le mie
          </label>
        )}
        <button type="submit">Cerca</button>
      </form>

      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {data && data.items.length === 0 && <p className="muted">Nessuna pratica trovata.</p>}
      {data && data.items.length > 0 && (
        <>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Tipo</th>
                <th scope="col">Stato</th>
                <th scope="col">Aggiornata</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/pratiche/${p.id}`}>{p.name}</Link>
                    {seesOrganization && p.userId === me.userId && (
                      <span className="badge">mia</span>
                    )}
                  </td>
                  <td>{p.typeLabel}</td>
                  <td>
                    <span className={`state state-${p.status.toLowerCase()}`}>
                      {STATE_LABELS[p.status]}
                    </span>
                  </td>
                  <td>{formatDate(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav className="pager" aria-label="Pagine">
            <button
              type="button"
              className="secondary"
              disabled={data.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              Precedente
            </button>
            <span>
              Pagina {data.page} di {Math.max(1, data.totalPages)} · {data.total} pratiche
            </span>
            <button
              type="button"
              className="secondary"
              disabled={data.page >= data.totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              Successiva
            </button>
          </nav>
        </>
      )}
    </>
  );
}
